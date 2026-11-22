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
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __APPLE__
#include <sys/sysctl.h>
#endif

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
typedef int32_t (*krun_add_disk_t)(uint32_t ctx_id, const char *block_id, const char *disk_path,
                                   bool read_only);
typedef int32_t (*krun_set_root_disk_remount_t)(uint32_t ctx_id, const char *device,
                                                const char *fstype, const char *options);
typedef int32_t (*krun_disable_implicit_vsock_t)(uint32_t ctx_id);
typedef int32_t (*krun_add_vsock_t)(uint32_t ctx_id, uint32_t tsi_features);
typedef int32_t (*krun_add_vsock_port_t)(uint32_t ctx_id, uint32_t port, const char *filepath);
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
  krun_add_disk_t krun_add_disk;
  krun_set_root_disk_remount_t krun_set_root_disk_remount;
  krun_disable_implicit_vsock_t krun_disable_implicit_vsock;
  krun_add_vsock_t krun_add_vsock;
  krun_add_vsock_port_t krun_add_vsock_port;
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
  uint32_t port;
  char *path;
} VsockPort;

typedef struct {
  char *rootfs;
  bool rootfs_is_image;
  unsigned cpus;
  unsigned memory;
  Share shares[MAX_SHARES];
  unsigned nshares;
  VsockPort ports[8];
  unsigned nports;
  char *pidfile;
  EnvVar *env;
  unsigned nenv;
  unsigned env_cap;
  char *workdir;
  char *dns;
  unsigned log_level;
  unsigned watch_pid; /* 0 = not given: don't watch an owner process */
  unsigned timeout;   /* 0 = not given: no time limit */
  char *stderr_file;  /* NULL = keep the launcher's stderr on the inherited fd 2 */
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

/*
 * Send the launcher's own stderr (and libkrun's log lines) to the file hive gives us, so a failed
 * boot's message reaches the run's error instead of the pasta process's stderr, which hive never
 * sees. Opened before fork(), so both processes inherit it; O_NOFOLLOW because the path is in the
 * run folder, which a previous agent may have filled with symlinks.
 */
static void redirect_stderr(const char *path) {
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) fail_runtime("cannot open --stderr-file \"%s\": %s", path, strerror(errno));
  if (dup2(fd, STDERR_FILENO) < 0) {
    int err = errno;
    close(fd);
    fail_runtime("cannot redirect stderr to \"%s\": %s", path, strerror(err));
  }
  close(fd);
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

/*
 * --rootfs: a rootfs directory (shared read-only over virtiofs) or a raw disk image (attached
 * read-only with virtio-blk and mounted as the guest's /). Linux uses the directory; macOS uses
 * the image, because a folder rootfs on a Mac would need virtiofs for / and loses case and
 * ownership semantics (docs/MACOS.md). Stored as its realpath().
 */
static char *resolve_rootfs(const char *opt, const char *path, bool *is_image) {
  if (path[0] != '/') fail_usage("%s must be an absolute path (got \"%s\")", opt, path);
  struct stat st;
  if (stat(path, &st) != 0) fail_usage("%s does not exist: \"%s\"", opt, path);
  if (!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode)) {
    fail_usage("%s is neither a directory nor a disk image: \"%s\"", opt, path);
  }
  *is_image = S_ISREG(st.st_mode);
  char *rp = realpath(path, NULL);
  if (!rp) fail_usage("%s: realpath(\"%s\") failed: %s", opt, path, strerror(errno));
  return rp;
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

/*
 * --vsock PORT:HOST_SOCKET maps one guest vsock port to a host UNIX socket. With it the launcher
 * disables the implicit (TSI) vsock device, so the guest has no IP network at all and the mapped
 * port is its only way out (docs/MACOS.md). sun_path caps the socket path at 104 bytes on macOS.
 */
static void add_vsock(Options *o, const char *spec) {
  if (o->nports >= sizeof o->ports / sizeof o->ports[0]) {
    fail_usage("at most %zu --vsock options are supported", sizeof o->ports / sizeof o->ports[0]);
  }
  const char *colon = strchr(spec, ':');
  if (!colon) fail_usage("--vsock expects PORT:HOST_SOCKET (got \"%s\")", spec);
  char *port_text = xstrndup(spec, (size_t)(colon - spec));
  unsigned port = parse_uint("--vsock port", port_text, 1, 65535);
  free(port_text);
  const char *path = colon + 1;
  if (path[0] != '/') fail_usage("--vsock host socket must be an absolute path (got \"%s\")", spec);
  if (strlen(path) >= 104) fail_usage("--vsock host socket path is too long (max 103 bytes): \"%s\"", path);
  VsockPort *p = &o->ports[o->nports++];
  p->port = (uint32_t)port;
  p->path = xstrdup(path);
}

/*
 * The launcher's pid, in the run folder, for a later process to find and stop a VM whose hive is
 * gone. O_NOFOLLOW: the run folder is host-only, but a stale symlink there must not be followed.
 * Removed when the launcher exits normally; a crash leaves it for the next startup's recovery.
 */
static void write_pidfile(const char *path) {
  char text[32];
  int len = snprintf(text, sizeof text, "%d\n", (int)getpid());
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) fail_runtime("cannot open --pidfile \"%s\": %s", path, strerror(errno));
  ssize_t written = write(fd, text, (size_t)len);
  int err = errno;
  close(fd);
  if (written != len) fail_runtime("cannot write --pidfile \"%s\": %s", path, strerror(err));
}

/* The pidfile to remove when this process exits; both the launcher and, after the fork, the VM
 * process inherit it, so a normal exit at either end cleans up and a crash leaves it behind. */
static const char *exit_pidfile;

static void remove_exit_pidfile(void) {
  if (exit_pidfile) (void)unlink(exit_pidfile);
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
  printf(",\"rootfs_image\":%s", o->rootfs_is_image ? "true" : "false");
  printf(",\"cpus\":%u,\"memory\":%u", o->cpus, o->memory);
  fputs(",\"watch_pid\":", stdout);
  if (o->watch_pid) {
    printf("%u", o->watch_pid);
  } else {
    fputs("null", stdout);
  }
  fputs(",\"timeout\":", stdout);
  if (o->timeout) {
    printf("%u", o->timeout);
  } else {
    fputs("null", stdout);
  }
  fputs(",\"stderr_file\":", stdout);
  if (o->stderr_file) {
    json_string(o->stderr_file);
  } else {
    fputs("null", stdout);
  }
  fputs(",\"shares\":[", stdout);
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
  fputs("],\"vsock\":[", stdout);
  for (unsigned i = 0; i < o->nports; i++) {
    if (i) putchar(',');
    printf("{\"port\":%u,\"path\":", o->ports[i].port);
    json_string(o->ports[i].path);
    putchar('}');
  }
  fputs("],\"workdir\":", stdout);
  json_string(o->workdir);
  fputs(",\"dns\":", stdout);
  if (o->dns) {
    json_string(o->dns);
  } else {
    fputs("null", stdout);
  }
  fputs(",\"pidfile\":", stdout);
  if (o->pidfile) {
    json_string(o->pidfile);
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

/* NULL-terminated envp: the --env/--setenv vars plus HIVE_SHARES/HIVE_WORKDIR/HIVE_DNS and the
 * vsock port hive-vm-init starts hive-netd for. */
static char **build_envp(const Options *o) {
  size_t cap = o->nenv + 5;
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
  if (o->nports > 0 && getenv("HIVE_VSOCK_PORT") == NULL) {
    if (asprintf(&envp[n], "HIVE_VSOCK_PORT=%u", o->ports[0].port) < 0) oom();
    n++;
  }
  envp[n] = NULL;
  return envp;
}

/* ---- control directory ---------------------------------------------------- */

/*
 * argv and env travel to the guest as files in a virtiofs-shared control directory: libkrun
 * puts krun_set_exec's argv/envp on the kernel command line, which holds only a couple of KB
 * and breaks arguments containing quotes. The guest init reads the files before it execs.
 */

static char *make_ctl_dir(void) {
  const char *base = getenv("XDG_RUNTIME_DIR");
  struct stat st;
  if (!base || !*base || stat(base, &st) != 0 || !S_ISDIR(st.st_mode)) base = "/tmp";
  char *tmpl = NULL;
  if (asprintf(&tmpl, "%s/hive-vm-XXXXXX", base) < 0) oom();
  if (!mkdtemp(tmpl)) fail_runtime("mkdtemp(\"%s\") failed: %s", tmpl, strerror(errno));
  return tmpl;
}

/* Each item is written followed by one NUL byte. Returns 0, or -1 with errno set. */
static int write_nul_file(const char *dir, const char *name, char *const *items) {
  char *path = NULL;
  if (asprintf(&path, "%s/%s", dir, name) < 0) oom();
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) {
    int err = errno;
    free(path);
    errno = err;
    return -1;
  }
  for (size_t i = 0; items[i]; i++) {
    const char *p = items[i];
    size_t len = strlen(p) + 1; /* include the terminating NUL */
    while (len > 0) {
      ssize_t n = write(fd, p, len);
      if (n < 0) {
        if (errno == EINTR) continue;
        int err = errno;
        close(fd);
        free(path);
        errno = err;
        return -1;
      }
      p += n;
      len -= (size_t)n;
    }
  }
  if (close(fd) != 0) {
    int err = errno;
    free(path);
    errno = err;
    return -1;
  }
  free(path);
  return 0;
}

/* Remove the control directory and the two files in it; individual failures are ignored. */
static void remove_ctl(const char *ctl) {
  char *path = NULL;
  if (asprintf(&path, "%s/argv", ctl) < 0) oom();
  (void)unlink(path);
  free(path);
  if (asprintf(&path, "%s/env", ctl) < 0) oom();
  (void)unlink(path);
  free(path);
  (void)rmdir(ctl);
}

static volatile sig_atomic_t signal_child = -1;

static void forward_signal(int signo) {
  pid_t child = (pid_t)signal_child;
  if (child > 0) kill(child, signo);
}

static void sleep_ms(long ms) {
  struct timespec ts;
  ts.tv_sec = ms / 1000;
  ts.tv_nsec = (ms % 1000) * 1000000L;
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
    /* A forwarded signal interrupted the sleep; finish the remaining time. */
  }
}

static long elapsed_ms(const struct timespec *since) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (now.tv_sec - since->tv_sec) * 1000L + (now.tv_nsec - since->tv_nsec) / 1000000L;
}

/* SIGTERM the child, poll for it for up to 5 s, then SIGKILL it and reap it. */
static void stop_child(pid_t child) {
  (void)kill(child, SIGTERM);
  for (int i = 0; i < 50; i++) {
    int status = 0;
    pid_t waited = waitpid(child, &status, WNOHANG);
    if (waited == child || (waited < 0 && errno == ECHILD)) return;
    sleep_ms(100);
  }
  (void)kill(child, SIGKILL);
  int status = 0;
  pid_t waited;
  do {
    waited = waitpid(child, &status, 0);
  } while (waited < 0 && errno == EINTR);
}

/* ---- libkrun loading and invocation --------------------------------------- */

#ifdef __APPLE__
/*
 * libkrun loads its kernel bundle with dlopen("libkrunfw.5.dylib") when the VM starts, and dyld
 * searches the usual system paths only. A release bundle keeps libkrunfw next to libkrun, which is
 * not one of them, so load it from libkrun's own directory first; dyld then reuses that image when
 * libkrun asks for it by name. HIVE_LIBKRUNFW names the file explicitly. Best effort: with no
 * libkrunfw next to libkrun, dyld's own search still applies.
 */
static void preload_libkrunfw(const char *libkrun_path) {
  const char *named = getenv("HIVE_LIBKRUNFW");
  char *path = NULL;
  if (named && *named) {
    path = xstrdup(named);
  } else {
    const char *slash = strrchr(libkrun_path, '/');
    if (!slash) return;
    if (asprintf(&path, "%.*s/libkrunfw.5.dylib", (int)(slash - libkrun_path), libkrun_path) < 0) {
      oom();
    }
  }
  void *fw = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
  if (!fw) fprintf(stderr, "hive-vm: cannot preload %s: %s\n", path, dlerror());
  free(path);
}
#endif

static void *load_libkrun(void) {
  const char *lib = getenv("HIVE_LIBKRUN");
  if (!lib || !*lib) {
#ifdef __APPLE__
    lib = "libkrun.1.dylib";
#else
    lib = "libkrun.so.1";
#endif
  }
#ifdef __APPLE__
  preload_libkrunfw(lib);
#endif
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
  k->krun_add_disk = (krun_add_disk_t)load_symbol(lib, "krun_add_disk");
  k->krun_set_root_disk_remount =
      (krun_set_root_disk_remount_t)load_symbol(lib, "krun_set_root_disk_remount");
  k->krun_disable_implicit_vsock =
      (krun_disable_implicit_vsock_t)load_symbol(lib, "krun_disable_implicit_vsock");
  k->krun_add_vsock = (krun_add_vsock_t)load_symbol(lib, "krun_add_vsock");
  k->krun_add_vsock_port = (krun_add_vsock_port_t)load_symbol(lib, "krun_add_vsock_port");
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

/* The host's hardware virtualization: /dev/kvm on Linux, Hypervisor.framework on macOS. */
static bool hardware_virtualization(void) {
#ifdef __APPLE__
  int supported = 0;
  size_t len = sizeof supported;
  return sysctlbyname("kern.hv_support", &supported, &len, NULL, 0) == 0 && supported == 1;
#else
  return access("/dev/kvm", R_OK | W_OK) == 0;
#endif
}

static void check_virtualization(void) {
#ifdef __APPLE__
  if (!hardware_virtualization()) {
    fail_runtime("Hypervisor.framework is not available (kern.hv_support is not 1); "
                 "hive needs Apple silicon and macOS 14 or newer");
  }
#else
  if (!hardware_virtualization()) fail_runtime("/dev/kvm is not usable");
#endif
}

static void do_check(void) {
  check_virtualization();
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
      o.rootfs = resolve_rootfs("--rootfs", val, &o.rootfs_is_image);
    } else if (strcmp(arg, "--vsock") == 0) {
      add_vsock(&o, take_value(&i, argc, argv, arg));
    } else if (strcmp(arg, "--pidfile") == 0) {
      const char *val = take_value(&i, argc, argv, arg);
      if (val[0] != '/') fail_usage("--pidfile must be an absolute path (got \"%s\")", val);
      free(o.pidfile);
      o.pidfile = xstrdup(val);
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
    } else if (strcmp(arg, "--watch-pid") == 0) {
      o.watch_pid = parse_uint("--watch-pid", take_value(&i, argc, argv, arg), 1, 4194304);
    } else if (strcmp(arg, "--timeout") == 0) {
      o.timeout = parse_uint("--timeout", take_value(&i, argc, argv, arg), 1, 86400);
    } else if (strcmp(arg, "--stderr-file") == 0) {
      const char *val = take_value(&i, argc, argv, arg);
      if (val[0] != '/') fail_usage("--stderr-file must be an absolute path (got \"%s\")", val);
      free(o.stderr_file);
      o.stderr_file = xstrdup(val);
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
  if (o.stderr_file) redirect_stderr(o.stderr_file);
  check_virtualization();
#ifdef __APPLE__
  /* No TSI fallback here: a macOS VM's only shared paths are its virtiofs shares, and its only
   * network path is the egress proxy behind --vsock (docs/MACOS.md). */
  if (!o.rootfs_is_image) {
    fail_runtime("--rootfs must be a raw disk image on macOS, not a folder (docs/MACOS.md)");
  }
  if (o.nports == 0) {
    fail_runtime("--vsock is required on macOS: without it libkrun gives the guest its implicit TSI network");
  }
#endif
  if (o.pidfile) {
    write_pidfile(o.pidfile);
    exit_pidfile = o.pidfile;
    (void)atexit(remove_exit_pidfile);
  }

  char *ctl = make_ctl_dir();
  char **envp = build_envp(&o);
  if (write_nul_file(ctl, "argv", &argv[command_index]) != 0) {
    int err = errno;
    remove_ctl(ctl);
    fail_runtime("cannot write %s/argv: %s", ctl, strerror(err));
  }
  if (write_nul_file(ctl, "env", envp) != 0) {
    int err = errno;
    remove_ctl(ctl);
    fail_runtime("cannot write %s/env: %s", ctl, strerror(err));
  }

  struct timespec started;
  if (clock_gettime(CLOCK_MONOTONIC, &started) != 0) {
    int err = errno;
    remove_ctl(ctl);
    fail_runtime("clock_gettime(CLOCK_MONOTONIC) failed: %s", strerror(err));
  }
  pid_t owner = getppid();

  pid_t child = fork();
  if (child < 0) {
    int err = errno;
    remove_ctl(ctl);
    fail_runtime("fork failed: %s", strerror(err));
  }
  if (child > 0) {
    /* Parent: forward termination signals, watch the owner and the time limit, then tear down the
     * control directory. */
    signal_child = (sig_atomic_t)child;
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = forward_signal;
    sigemptyset(&sa.sa_mask);
    (void)sigaction(SIGTERM, &sa, NULL);
    (void)sigaction(SIGINT, &sa, NULL);
    (void)sigaction(SIGHUP, &sa, NULL);
    int status = 0;
    for (;;) {
      pid_t waited = waitpid(child, &status, WNOHANG);
      if (waited == child) break;
      if (waited < 0 && errno != EINTR) {
        int err = errno;
        remove_ctl(ctl);
        fail_runtime("waitpid(%d) failed: %s", (int)child, strerror(err));
      }
      if (o.watch_pid && kill((pid_t)o.watch_pid, 0) == -1 && errno == ESRCH) {
        fprintf(stderr, "hive-vm: owner process %u is gone; stopping the VM\n", o.watch_pid);
        stop_child(child);
        remove_ctl(ctl);
        exit(125);
      }
      if (owner != 1 && getppid() == 1) {
        fprintf(stderr, "hive-vm: owner process %d is gone; stopping the VM\n", (int)owner);
        stop_child(child);
        remove_ctl(ctl);
        exit(125);
      }
      if (o.timeout && elapsed_ms(&started) >= (long)o.timeout * 1000L) {
        fprintf(stderr, "hive-vm: timed out after %u s; stopping the VM\n", o.timeout);
        stop_child(child);
        remove_ctl(ctl);
        exit(124);
      }
      sleep_ms(500);
    }
    remove_ctl(ctl);
    if (WIFEXITED(status)) exit(WEXITSTATUS(status));
    if (WIFSIGNALED(status)) exit(128 + WTERMSIG(status));
    exit(1);
  }

  /* Child: load libkrun, share the control directory and boot the VM. */
  void *lib = load_libkrun();
  Krun k;
  load_symbols(lib, &k);

  KRUN_CALL(k, krun_set_log_level, o.log_level);
  int32_t ctx = k.krun_create_ctx();
  if (ctx < 0) krun_fail("krun_create_ctx", ctx);
  KRUN_CALL(k, krun_set_vm_config, (uint32_t)ctx, (uint8_t)o.cpus, (uint32_t)o.memory);
  if (o.rootfs_is_image) {
    /* The raw image is the guest's /: attached read-only, and mounted "ro" so the guest does not
     * even try an rw mount on the read-only block device (that fails at boot). */
    KRUN_CALL(k, krun_add_disk, (uint32_t)ctx, "root", o.rootfs, true);
    KRUN_CALL(k, krun_set_root_disk_remount, (uint32_t)ctx, "/dev/vda", "ext4", "ro");
  } else {
#ifndef __APPLE__
    KRUN_CALL(k, krun_add_virtiofs3, (uint32_t)ctx, "/dev/root", o.rootfs, (uint64_t)0, true);
#endif
  }
  for (unsigned i = 0; i < o.nshares; i++) {
    char tag[16];
    share_tag(i, tag, sizeof tag);
    KRUN_CALL(k, krun_add_virtiofs3, (uint32_t)ctx, tag, o.shares[i].host, (uint64_t)0,
              o.shares[i].ro);
  }
  /* The control directory is not a task share: no tag in HIVE_SHARES, no 8-share limit. */
  KRUN_CALL(k, krun_add_virtiofs3, (uint32_t)ctx, "hivectl", ctl, (uint64_t)0, false);
  if (o.nports > 0) {
    /* No implicit vsock: no TSI hijacking of AF_INET/AF_INET6. Each mapped port is the guest's
     * only route to the host, and behind it only hive's egress proxy. */
    KRUN_CALL(k, krun_disable_implicit_vsock, (uint32_t)ctx);
    KRUN_CALL(k, krun_add_vsock, (uint32_t)ctx, 0);
    for (unsigned i = 0; i < o.nports; i++) {
      KRUN_CALL(k, krun_add_vsock_port, (uint32_t)ctx, o.ports[i].port, o.ports[i].path);
    }
  }
  const char *rlimits[] = {"7=65536:65536", NULL};
  KRUN_CALL(k, krun_set_rlimits, (uint32_t)ctx, rlimits);
#ifndef __APPLE__
  /* Empty, not NULL: a NULL port map would expose every listening guest port to the host. */
  const char *port_map[] = {NULL};
  KRUN_CALL(k, krun_set_port_map, (uint32_t)ctx, port_map);
#endif
  KRUN_CALL(k, krun_set_workdir, (uint32_t)ctx, "/");
  /* Empty argv (never NULL) and only HIVE_CTL: everything else comes from the files. */
  const char *exec_argv[] = {NULL};
  const char *exec_envp[] = {"HIVE_CTL=hivectl", NULL};
  KRUN_CALL(k, krun_set_exec, (uint32_t)ctx, EXEC_PATH, exec_argv, exec_envp);
  int32_t rc = k.krun_start_enter((uint32_t)ctx);
  fail_runtime("krun_start_enter failed: %d", rc);
}
