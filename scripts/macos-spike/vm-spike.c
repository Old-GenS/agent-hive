// Phase 0 spike launcher for libkrun on macOS/arm64.
//
// This is not part of hive's product build. It exists to prove the transport
// and filesystem choices in docs/MACOS.md on real hardware before Phase 1
// changes vm/hive-vm.c and src/sandbox.ts.
//
// Build (after scripts/macos-spike/build-libkrun.sh):
//   clang -O2 -Wall -Wextra -Werror \
//     -I.scratch/prefix/include -L.scratch/prefix/lib -lkrun \
//     -Wl,-rpath,"$PWD/.scratch/prefix/lib" \
//     -o .scratch/spike/vm-spike scripts/macos-spike/vm-spike.c
//   codesign --force --sign - --entitlements scripts/macos-spike/entitlements.plist \
//     .scratch/spike/vm-spike
#include <errno.h>
#include <libkrun.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_SHARES 8
#define MAX_PORTS 8
#define MAX_ENV 64

struct share {
    const char *tag;
    const char *path;
};

struct vsock_port {
    uint32_t port;
    const char *path;
};

static void usage(const char *prog) {
    fprintf(stderr,
        "usage: %s [options] -- PROG [ARGS...]\n"
        "  --root DIR          boot from a virtio-fs directory (TSI build mode)\n"
        "  --rootfs IMG        boot from a raw ext4 image over virtio-blk\n"
        "  --rw                attach the root image writable (default: read-only)\n"
        "  --share TAG=PATH    add a virtio-fs share (repeatable, max %d)\n"
        "  --vsock PORT:PATH   disable implicit vsock, add a TSI-free vsock and map\n"
        "                      PORT to the host UNIX socket PATH (repeatable, max %d;\n"
        "                      PORT=PATH is accepted too)\n"
        "  --tsi               keep the implicit vsock/TSI device\n"
        "  --env NAME=VALUE    guest environment (repeatable; PATH, HOME and TERM are\n"
        "                      set by default, and the host environment is never inherited)\n"
        "  --cpus N            vCPUs (default 2)\n"
        "  --ram MIB           RAM in MiB (default 2048)\n"
        "  --verbose           libkrun INFO logging (default: warnings)\n",
        prog, MAX_SHARES, MAX_PORTS);
}

/* Split "left=right", or with allow_colon also "left:right", in place. */
static int parse_pair(char *arg, bool allow_colon, char **left, char **right) {
    char *sep = strchr(arg, '=');
    if (sep == NULL && allow_colon) sep = strchr(arg, ':');
    if (sep == NULL || sep == arg || sep[1] == '\0') return -1;
    *sep = '\0';
    *left = arg;
    *right = sep + 1;
    return 0;
}

int main(int argc, char **argv) {
    const char *root = NULL;
    const char *rootfs = NULL;
    int writable = 0;
    int keep_tsi = 0;
    int verbose = 0;
    int cpus = 2;
    unsigned ram_mib = 2048;
    struct share shares[MAX_SHARES];
    struct vsock_port ports[MAX_PORTS];
    const char *env[MAX_ENV];
    int nshares = 0;
    int nports = 0;
    int nenv = 0;
    int i;

    // The libkrun init blob passes the guest environment through the kernel
    // command line, which has a hard size limit. Never inherit the caller's
    // whole environment: an agent shell can easily overflow it.
    env[nenv++] = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    env[nenv++] = "HOME=/root";
    env[nenv++] = "TERM=xterm";

    for (i = 1; i < argc; i++) {
        const char *arg = argv[i];
        if (strcmp(arg, "--") == 0) {
            i++;
            break;
        } else if (strcmp(arg, "--root") == 0 && i + 1 < argc) {
            root = argv[++i];
        } else if (strcmp(arg, "--rootfs") == 0 && i + 1 < argc) {
            rootfs = argv[++i];
        } else if (strcmp(arg, "--rw") == 0) {
            writable = 1;
        } else if (strcmp(arg, "--tsi") == 0) {
            keep_tsi = 1;
        } else if (strcmp(arg, "--verbose") == 0) {
            verbose = 1;
        } else if (strcmp(arg, "--share") == 0 && i + 1 < argc) {
            if (nshares == MAX_SHARES) { fprintf(stderr, "too many shares\n"); return 2; }
            if (parse_pair(argv[++i], false, (char **)&shares[nshares].tag,
                          (char **)&shares[nshares].path) < 0) {
                fprintf(stderr, "bad --share, want TAG=PATH\n");
                return 2;
            }
            nshares++;
        } else if (strcmp(arg, "--vsock") == 0 && i + 1 < argc) {
            char *port_text;
            char *path;
            char *end = NULL;
            unsigned long port;
            if (nports == MAX_PORTS) { fprintf(stderr, "too many vsock ports\n"); return 2; }
            if (parse_pair(argv[++i], true, &port_text, &path) < 0) {
                fprintf(stderr, "bad --vsock, want PORT:PATH\n");
                return 2;
            }
            port = strtoul(port_text, &end, 10);
            if (end == port_text || *end != '\0' || port == 0 || port > UINT32_MAX) {
                fprintf(stderr, "bad vsock port: %s\n", port_text);
                return 2;
            }
            ports[nports].port = (uint32_t)port;
            ports[nports].path = path;
            nports++;
        } else if (strcmp(arg, "--env") == 0 && i + 1 < argc) {
            if (nenv == MAX_ENV - 1) { fprintf(stderr, "too many --env\n"); return 2; }
            env[nenv++] = argv[++i];
        } else if (strcmp(arg, "--cpus") == 0 && i + 1 < argc) {
            cpus = atoi(argv[++i]);
        } else if (strcmp(arg, "--ram") == 0 && i + 1 < argc) {
            ram_mib = (unsigned)strtoul(argv[++i], NULL, 10);
        } else if (strcmp(arg, "-h") == 0 || strcmp(arg, "--help") == 0) {
            usage(argv[0]);
            return 0;
        } else if (arg[0] == '-') {
            fprintf(stderr, "unknown option: %s\n", arg);
            usage(argv[0]);
            return 2;
        } else {
            break;
        }
    }

    if (i >= argc) {
        fprintf(stderr, "missing guest program\n");
        usage(argv[0]);
        return 2;
    }
    if (root != NULL && rootfs != NULL) {
        fprintf(stderr, "use either --root or --rootfs\n");
        return 2;
    }
    if (root == NULL && rootfs == NULL) {
        fprintf(stderr, "one of --root or --rootfs is required\n");
        return 2;
    }
    if (cpus < 1 || cpus > 32 || ram_mib < 128) {
        fprintf(stderr, "bad --cpus or --ram\n");
        return 2;
    }

    krun_set_log_level(verbose ? KRUN_LOG_LEVEL_INFO : KRUN_LOG_LEVEL_WARN);

    int32_t ctx = krun_create_ctx();
    if (ctx < 0) {
        errno = -ctx;
        perror("krun_create_ctx");
        return 1;
    }

    int32_t err = krun_set_vm_config((uint32_t)ctx, (uint8_t)cpus, ram_mib);
    if (err < 0) {
        errno = -err;
        perror("krun_set_vm_config");
        return 1;
    }

    if (rootfs != NULL) {
        // The host opens the image read-only and libkrun marks the virtio-blk
        // device read-only. The guest init still needs "ro" in its options to
        // mount it read-only instead of failing the rw mount with EACCES.
        err = krun_add_disk((uint32_t)ctx, "root", rootfs, !writable);
        if (err < 0) {
            errno = -err;
            perror("krun_add_disk");
            return 1;
        }
        // /dev/vda is the first virtio-blk device. The image is a bare ext4
        // filesystem (no partition table), so the device itself is the root.
        err = krun_set_root_disk_remount((uint32_t)ctx, "/dev/vda", "ext4",
                                         writable ? NULL : "ro");
        if (err < 0) {
            errno = -err;
            perror("krun_set_root_disk_remount");
            return 1;
        }
        fprintf(stderr, "[spike] root image %s (%s)\n", rootfs,
                writable ? "rw" : "read-only, host-enforced");
    } else {
        err = krun_set_root((uint32_t)ctx, root);
        if (err < 0) {
            errno = -err;
            perror("krun_set_root");
            return 1;
        }
        fprintf(stderr, "[spike] root directory %s (TSI build mode)\n", root);
    }

    for (int n = 0; n < nshares; n++) {
        err = krun_add_virtiofs((uint32_t)ctx, shares[n].tag, shares[n].path);
        if (err < 0) {
            errno = -err;
            fprintf(stderr, "krun_add_virtiofs(%s, %s): %s\n",
                    shares[n].tag, shares[n].path, strerror(errno));
            return 1;
        }
        fprintf(stderr, "[spike] share %s -> %s\n", shares[n].tag, shares[n].path);
    }

    if (nports > 0) {
        // No implicit vsock means no TSI hijacking of AF_INET/AF_INET6. The
        // only guest network path is the mapped port below.
        err = krun_disable_implicit_vsock((uint32_t)ctx);
        if (err < 0) {
            errno = -err;
            perror("krun_disable_implicit_vsock");
            return 1;
        }
        err = krun_add_vsock((uint32_t)ctx, 0);
        if (err < 0) {
            errno = -err;
            perror("krun_add_vsock");
            return 1;
        }
        for (int n = 0; n < nports; n++) {
            err = krun_add_vsock_port((uint32_t)ctx, ports[n].port, ports[n].path);
            if (err < 0) {
                errno = -err;
                fprintf(stderr, "krun_add_vsock_port(%u, %s): %s\n",
                        ports[n].port, ports[n].path, strerror(errno));
                return 1;
            }
            fprintf(stderr, "[spike] vsock port %u -> %s (TSI off)\n",
                    ports[n].port, ports[n].path);
        }
    } else if (keep_tsi) {
        fprintf(stderr, "[spike] implicit vsock with TSI\n");
    }

    env[nenv] = NULL;

    const char *exec_path = argv[i];
    // krun_set_exec's envp is what the guest gets. Passing NULL makes it
    // inherit the caller's entire environment via the kernel cmdline.
    err = krun_set_exec((uint32_t)ctx, exec_path, (const char *const *)&argv[i],
                        (const char *const *)env);
    if (err < 0) {
        errno = -err;
        perror("krun_set_exec");
        return 1;
    }

    fprintf(stderr, "[spike] starting VM: %s\n", exec_path);
    return krun_start_enter((uint32_t)ctx);
}
