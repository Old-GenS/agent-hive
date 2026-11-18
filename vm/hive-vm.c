/*
 * hive-vm — boot one task in its own libkrun microVM.
 *
 * libkrun is loaded at run time with dlopen()/dlsym() so this builds anywhere and the CLI
 * (--dry-run, --check, argument validation) works without libkrun installed. The guest gets
 * the rootfs read-only at /, task shares as virtiofs mounts, and an empty port map so nothing
 * the guest listens on is reachable from the host.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <arpa/inet.h>
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_SHARES 8
#define EXEC_PATH "/usr/local/bin/hive-vm-init"

/* The libkrun ABI we use, declared locally: no libkrun header needed to build. */
typedef int32_t (*krun_set_log_level_t)(uint32_t level);
typedef int32_t (*krun_create_ctx_t)(void);
typedef int32_t (*krun_free_ctx_t)(uint32_t ctx_id);
typedef int32_t (*krun_set_vm_config_t)(uint32_t ctx_id, uint8_t num_vcpus, uint32_t ram_mib);
typedef int32_t (*krun_add_virtiofs3_t)(uint32_t ctx_id, const char *c_tag, const char *c_path,
                                        uint64_t shm_size, bool read_only);
typedef int32_t (*krun_set_workdir_t)(uint32_t ctx_id, const char *workdir_path);
typedef int32_t (*krun_set_exec_t)(uint32_t ctx_id, const char *exec_path,
                                   const char *const argv[], const char *const envp[]);
typedef int32_t (*krun_set_rlimits_t)(uint32_t ctx_id, const char *const rlimits[]);
typedef int32_t (*krun_set_port_map_t)(uint32_t ctx_id, const char *const port_map[]);
typedef int32_t (*krun_start_enter_t)(uint32_t ctx_id);

typedef struct {
  krun_set_log_level_t krun_set_log_level;
  krun_create_ctx_t krun_create_ctx;
  krun_free_ctx_t krun_free_ctx;
  krun_set_vm_config_t krun_set_vm_config;
  krun_add_virtiofs3_t krun_add_virtiofs3;
  krun_set_workdir_t krun_set_workdir;
  krun_set_exec_t krun_set_exec;
  krun_set_rlimits_t krun_set_rlimits;
  krun_set_port_map_t krun_set_port_map;
  krun_start_enter_t krun_start_enter;
} Krun;

typedef struct {
  char *host;  /* realpath() of the host directory */
  char *guest; /* absolute guest mount point */
  bool ro;
} Share;

typedef struct {
  char *name;
  char *value;
} EnvVar;

typedef struct {
  char *rootfs;
  unsigned cpus;
  unsigned memory;
  Share shares[MAX_SHARES];
  unsigned nshares;
  EnvVar *env;
  unsigned nenv;
  unsigned env_cap;
  char *workdir;
  char *dns;
  unsigned log_level;
  bool dry_run;
} Options;

/* ---- small helpers ------------------------------------------------------- */

static void oom(void) {
  fputs("hive-vm: out of memory\n", stderr);
  exit(1);
}

static char *xstrdup(const char *s) {
  char *p = strdup(s);
  if (!p) oom();
  return p;
}

static char *xstrndup(const char *s, size_t n) {
  char *p = strndup(s, n);
  if (!p) oom();
  return p;
}

static void vfail(int code, const char *fmt, va_list ap) {
  fputs("hive-vm: ", stderr);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  exit(code);
}

static void fail_usage(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfail(2, fmt, ap);
  va_end(ap);
}

static void fail_runtime(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfail(1, fmt, ap);
  va_end(ap);
}

static const char *take_value(int *i, int argc, char **argv, const char *opt) {
  if (*i + 1 >= argc) fail_usage("option %s requires a value", opt);
  return argv[++(*i)];
}

static bool valid_env_name(const char *name) {
  if (!name[0]) return false;
  if (!(isalpha((unsigned char)name[0]) || name[0] == '_')) return false;
  for (const char *p = name + 1; *p; p++) {
    if (!(isalnum((unsigned char)*p) || *p == '_')) return false;
  }
  return true;
}

static unsigned parse_uint(const char *opt, const char *val, unsigned lo, unsigned hi) {
  char *end = NULL;
  errno = 0;
  long v = strtol(val, &end, 10);
  if (errno != 0 || end == val || *end != '\0' || v < (long)lo || v > (long)hi) {
    fail_usage("%s must be an integer in %u..%u (got \"%s\")", opt, lo, hi, val);
  }
  return (unsigned)v;
}

/* An absolute existing directory, stored as its realpath(). */
static char *resolve_host_dir(const char *opt, const char *path) {
  if (path[0] != '/') fail_usage("%s must be an absolute path (got \"%s\")", opt, path);
  struct stat st;
  if (stat(path, &st) != 0 || !S_ISDIR(st.st_mode)) {
    fail_usage("%s is not an existing directory: \"%s\"", opt, path);
  }
  char *rp = realpath(path, NULL);
  if (!rp) fail_usage("%s: realpath(\"%s\") failed: %s", opt, path, strerror(errno));
  return rp;
}

/* Absolute guest path without ".." components, ':' or ','. */
static void validate_guest_path(const char *path) {
  if (path[0] != '/') fail_usage("guest path must be absolute (got \"%s\")", path);
  if (strchr(path, ':') || strchr(path, ',')) {
    fail_usage("guest path must not contain ':' or ',' (got \"%s\")", path);
  }
  const char *p = path;
  while (*p) {
    while (*p == '/') p++;
    const char *start = p;
    while (*p && *p != '/') p++;
    if (p - start == 2 && start[0] == '.' && start[1] == '.') {
      fail_usage("guest path must not contain \"..\" components (got \"%s\")", path);
    }
  }
}

static void add_env(Options *o, const char *name, const char *value) {
  if (o->nenv == o->env_cap) {
    unsigned cap = o->env_cap ? o->env_cap * 2 : 8;
    EnvVar *grown = realloc(o->env, cap * sizeof(*grown));
    if (!grown) oom();
    o->env = grown;
    o->env_cap = cap;
  }
  o->env[o->nenv].name = xstrdup(name);
  o->env[o->nenv].value = xstrdup(value);
  o->nenv++;
}

static void add_share(Options *o, const char *spec) {
  if (o->nshares >= MAX_SHARES) fail_usage("at most %d --share options are supported", MAX_SHARES);
  const char *first = strchr(spec, ':');
  if (!first) fail_usage("--share expects HOST:GUEST[:ro] (got \"%s\")", spec);
  char *host = xstrndup(spec, (size_t)(first - spec));
  const char *rest = first + 1;
  const char *second = strchr(rest, ':');
  bool ro = false;
  char *guest;
  if (second) {
    if (strcmp(second + 1, "ro") != 0) {
      fail_usage("--share suffix must be \":ro\" (got \"%s\")", spec);
    }
    guest = xstrndup(rest, (size_t)(second - rest));
    ro = true;
  } else {
    guest = xstrdup(rest);
  }
  char *real = resolve_host_dir("--share host", host);
  free(host);
  validate_guest_path(guest);
  Share *s = &o->shares[o->nshares++];
  s->host = real;
  s->guest = guest;
  s->ro = ro;
}

static void add_setenv(Options *o, const char *spec) {
  const char *eq = strchr(spec, '=');
  if (!eq) fail_usage("--setenv expects NAME=VALUE (got \"%s\")", spec);
  char *name = xstrndup(spec, (size_t)(eq - spec));
  if (!valid_env_name(name)) fail_usage("invalid environment variable name: \"%s\"", name);
  add_env(o, name, eq + 1);
  free(name);
}

/* ---- JSON ----------------------------------------------------------------- */

static void json_string(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    switch (*p) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\b': fputs("\\b", stdout); break;
      case '\f': fputs("\\f", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (*p < 0x20) {
          printf("\\u%04x", (unsigned)*p);
        } else {
          putchar(*p);
        }
    }
  }
  putchar('"');
}

static void share_tag(unsigned index, char *buf, size_t bufsz) {
  snprintf(buf, bufsz, "hive%u", index);
}

static void print_dry_run(const Options *o, char **command) {
  fputs("{\"rootfs\":", stdout);
  json_string(o->rootfs);
  printf(",\"cpus\":%u,\"memory\":%u,\"shares\":[", o->cpus, o->memory);
  for (unsigned i = 0; i < o->nshares; i++) {
    char tag[16];
    share_tag(i, tag, sizeof tag);
    if (i) putchar(',');
    fputs("{\"tag\":", stdout);
    json_string(tag);
    fputs(",\"host\":", stdout);
    json_string(o->shares[i].host);
    fputs(",\"guest\":", stdout);
    json_string(o->shares[i].guest);
    printf(",\"ro\":%s}", o->shares[i].ro ? "true" : "false");
  }
  fputs("],\"env\":[", stdout);
  for (unsigned i = 0; i < o->nenv; i++) {
    if (i) putchar(',');
    json_string(o->env[i].name);
  }
  fputs("],\"workdir\":", stdout);
  json_string(o->workdir);
  fputs(",\"dns\":", stdout);
  if (o->dns) {
    json_string(o->dns);
  } else {
    fputs("null", stdout);
  }
  fputs(",\"exec\":", stdout);
  json_string(EXEC_PATH);
  fputs(",\"argv\":[", stdout);
  for (char **p = command; *p; p++) {
    if (p != command) putchar(',');
    json_string(*p);
  }
  fputs("]}\n", stdout);
}

/* ---- guest environment ---------------------------------------------------- */

static char *shares_value(const Options *o) {
  char *out = xstrdup("");
  for (unsigned i = 0; i < o->nshares; i++) {
    char tag[16];
    share_tag(i, tag, sizeof tag);
    char *piece = NULL;
    if (asprintf(&piece, "%s%s:%s%s", i ? "," : "", tag, o->shares[i].guest,
                 o->shares[i].ro ? ":ro" : "") < 0) {
      oom();
    }
    char *next = NULL;
    if (asprintf(&next, "%s%s", out, piece) < 0) oom();
    free(out);
    free(piece);
    out = next;
  }
  return out;
}

/* NULL-terminated envp: the --env/--setenv vars plus HIVE_SHARES/HIVE_WORKDIR/HIVE_DNS. */
static char **build_envp(const Options *o) {
  size_t cap = o->nenv + 4;
  char **envp = calloc(cap, sizeof(*envp));
  if (!envp) oom();
  size_t n = 0;
  for (unsigned i = 0; i < o->nenv; i++) {
    if (asprintf(&envp[n], "%s=%s", o->env[i].name, o->env[i].value) < 0) oom();
    n++;
  }
  if (o->nshares > 0) {
    char *shares = shares_value(o);
    if (asprintf(&envp[n], "HIVE_SHARES=%s", shares) < 0) oom();
    free(shares);
    n++;
  }
  if (asprintf(&envp[n], "HIVE_WORKDIR=%s", o->workdir) < 0) oom();
  n++;
  if (o->dns) {
    if (asprintf(&envp[n], "HIVE_DNS=%s", o->dns) < 0) oom();
    n++;
  }
  envp[n] = NULL;
  return envp;
}

/* ---- libkrun loading and invocation --------------------------------------- */

static void *load_libkrun(void) {
  const char *lib = getenv("HIVE_LIBKRUN");
  if (!lib || !*lib) lib = "libkrun.so.1";
  void *handle = dlopen(lib, RTLD_NOW);
  if (!handle) {
    const char *err = dlerror();
    fail_runtime("%s", err ? err : "dlopen failed");
  }
  return handle;
}

static void *load_symbol(void *lib, const char *name) {
  dlerror();
  void *sym = dlsym(lib, name);
  const char *err = dlerror();
  if (err) fail_runtime("%s", err);
  return sym;
}

static void load_symbols(void *lib, Krun *k) {
  k->krun_set_log_level = (krun_set_log_level_t)load_symbol(lib, "krun_set_log_level");
  k->krun_create_ctx = (krun_create_ctx_t)load_symbol(lib, "krun_create_ctx");
  k->krun_free_ctx = (krun_free_ctx_t)load_symbol(lib, "krun_free_ctx");
  k->krun_set_vm_config = (krun_set_vm_config_t)load_symbol(lib, "krun_set_vm_config");
  k->krun_add_virtiofs3 = (krun_add_virtiofs3_t)load_symbol(lib, "krun_add_virtiofs3");
  k->krun_set_workdir = (krun_set_workdir_t)load_symbol(lib, "krun_set_workdir");
  k->krun_set_exec = (krun_set_exec_t)load_symbol(lib, "krun_set_exec");
  k->krun_set_rlimits = (krun_set_rlimits_t)load_symbol(lib, "krun_set_rlimits");
  k->krun_set_port_map = (krun_set_port_map_t)load_symbol(lib, "krun_set_port_map");
  k->krun_start_enter = (krun_start_enter_t)load_symbol(lib, "krun_start_enter");
}

static void krun_fail(const char *fn, int32_t rc) {
  fail_runtime("%s failed: %d", fn, rc);
}

#define KRUN_CALL(k, fn, ...)                       \
  do {                                              \
    int32_t rc_ = (k).fn(__VA_ARGS__);              \
    if (rc_ < 0) krun_fail(#fn, rc_);               \
  } while (0)

static bool kvm_usable(void) {
  return access("/dev/kvm", R_OK | W_OK) == 0;
}

static void do_check(void) {
  if (!kvm_usable()) fail_runtime("/dev/kvm is not usable");
  void *lib = load_libkrun();
  Krun k;
  load_symbols(lib, &k);
  int32_t ctx = k.krun_create_ctx();
  if (ctx < 0) krun_fail("krun_create_ctx", ctx);
  KRUN_CALL(k, krun_free_ctx, (uint32_t)ctx);
  puts("ok");
  exit(0);
}

/* ---- main ---------------------------------------------------------------- */

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--check") == 0) do_check();

  Options o;
  memset(&o, 0, sizeof o);
  o.cpus = 1;
  o.memory = 1024;
  o.log_level = 1;
  o.workdir = xstrdup("/");

  int command_index = -1;
  for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (strcmp(arg, "--") == 0) {
      command_index = i + 1;
      break;
    }
    if (strcmp(arg, "--dry-run") == 0) {
      o.dry_run = true;
    } else if (strcmp(arg, "--check") == 0) {
      fail_usage("--check cannot be combined with other arguments");
    } else if (strcmp(arg, "--rootfs") == 0) {
      const char *val = take_value(&i, argc, argv, arg);
      free(o.rootfs);
      o.rootfs = resolve_host_dir("--rootfs", val);
    } else if (strcmp(arg, "--cpus") == 0) {
      o.cpus = parse_uint("--cpus", take_value(&i, argc, argv, arg), 1, 16);
    } else if (strcmp(arg, "--memory") == 0) {
      o.memory = parse_uint("--memory", take_value(&i, argc, argv, arg), 128, 65536);
    } else if (strcmp(arg, "--share") == 0) {
      add_share(&o, take_value(&i, argc, argv, arg));
    } else if (strcmp(arg, "--env") == 0) {
      const char *name = take_value(&i, argc, argv, arg);
      if (!valid_env_name(name)) fail_usage("--env has an invalid variable name: \"%s\"", name);
      const char *value = getenv(name);
      if (value) add_env(&o, name, value);
    } else if (strcmp(arg, "--setenv") == 0) {
      add_setenv(&o, take_value(&i, argc, argv, arg));
    } else if (strcmp(arg, "--workdir") == 0) {
      const char *val = take_value(&i, argc, argv, arg);
      if (val[0] != '/') fail_usage("--workdir must be an absolute guest path (got \"%s\")", val);
      free(o.workdir);
      o.workdir = xstrdup(val);
    } else if (strcmp(arg, "--dns") == 0) {
      const char *val = take_value(&i, argc, argv, arg);
      struct in_addr addr;
      if (inet_pton(AF_INET, val, &addr) != 1) {
        fail_usage("--dns must be an IPv4 address (got \"%s\")", val);
      }
      free(o.dns);
      o.dns = xstrdup(val);
    } else if (strcmp(arg, "--log-level") == 0) {
      o.log_level = parse_uint("--log-level", take_value(&i, argc, argv, arg), 0, 5);
    } else {
      fail_usage("unknown argument: \"%s\"", arg);
    }
  }

  if (command_index < 0 || command_index >= argc) {
    fail_usage("missing command (use -- COMMAND [ARGS...])");
  }
  if (!o.rootfs) fail_usage("--rootfs is required");

  if (o.dry_run) {
    print_dry_run(&o, argv + command_index);
    return 0;
  }

  /* Normal run: every step below is fatal on failure. */
  if (!kvm_usable()) fail_runtime("/dev/kvm is not usable");
  void *lib = load_libkrun();
  Krun k;
  load_symbols(lib, &k);

  KRUN_CALL(k, krun_set_log_level, o.log_level);
  int32_t ctx = k.krun_create_ctx();
  if (ctx < 0) krun_fail("krun_create_ctx", ctx);
  KRUN_CALL(k, krun_set_vm_config, (uint32_t)ctx, (uint8_t)o.cpus, (uint32_t)o.memory);
  KRUN_CALL(k, krun_add_virtiofs3, (uint32_t)ctx, "/dev/root", o.rootfs, (uint64_t)0, true);
  for (unsigned i = 0; i < o.nshares; i++) {
    char tag[16];
    share_tag(i, tag, sizeof tag);
    KRUN_CALL(k, krun_add_virtiofs3, (uint32_t)ctx, tag, o.shares[i].host, (uint64_t)0,
              o.shares[i].ro);
  }
  const char *rlimits[] = {"7=65536:65536", NULL};
  KRUN_CALL(k, krun_set_rlimits, (uint32_t)ctx, rlimits);
  /* Empty, not NULL: a NULL port map would expose every listening guest port to the host. */
  const char *port_map[] = {NULL};
  KRUN_CALL(k, krun_set_port_map, (uint32_t)ctx, port_map);
  KRUN_CALL(k, krun_set_workdir, (uint32_t)ctx, "/");
  char **envp = build_envp(&o);
  KRUN_CALL(k, krun_set_exec, (uint32_t)ctx, EXEC_PATH,
            (const char *const *)&argv[command_index], (const char *const *)envp);
  int32_t rc = k.krun_start_enter((uint32_t)ctx);
  fail_runtime("krun_start_enter failed: %d", rc);
}
