/*
 * hive-netd -- the guest's only way out.
 *
 * Listens on 127.0.0.1:3128, the proxy address every tool in the VM is given, and relays each
 * connection over AF_VSOCK to the host, where the launcher (vm/hive-vm --vsock) mapped one port
 * to a UNIX socket owned by hive's egress proxy. The guest has no virtio-net device and no DNS:
 * names are resolved by the proxy on the host, which also refuses this computer and the LAN.
 *
 * Started by hive-vm-init only when the launcher mapped a port (HIVE_VSOCK_PORT). One fork per
 * connection, so a slow request never blocks the next one; the VM's lifetime bounds the total.
 *
 * Build static (glibc-static / musl): no library from the image is needed at run time.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/vm_sockets.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define DEFAULT_LISTEN_PORT 3128
#define DEFAULT_VSOCK_PORT 1024
#define BUF_SIZE (32 * 1024)

static int env_port(const char *name, int fallback) {
  const char *value = getenv(name);
  if (value == NULL || *value == '\0') return fallback;
  char *end = NULL;
  long port = strtol(value, &end, 10);
  if (end == value || *end != '\0' || port < 1 || port > 65535) return fallback;
  return (int)port;
}

static int set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int vsock_connect(uint32_t port) {
  int fd = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  struct sockaddr_vm addr;
  memset(&addr, 0, sizeof addr);
  addr.svm_family = AF_VSOCK;
  addr.svm_cid = VMADDR_CID_HOST; /* cid 2: the host, on the one port the launcher mapped */
  addr.svm_port = port;
  if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
    int err = errno;
    close(fd);
    errno = err;
    return -1;
  }
  return fd;
}

/* One direction's queue: bytes read from 'rd' and not yet written to 'wr'. */
struct channel {
  int rd;
  int wr;
  char buf[BUF_SIZE];
  size_t len;
  int rd_open;
  int wr_open;
};

static void shutdown_wr(struct channel *c) {
  if (c->wr_open) {
    (void)shutdown(c->wr, SHUT_WR);
    c->wr_open = 0;
  }
}

/* Copy both ways until both directions have finished, with backpressure instead of buffering
 * without limit. Returns when the connection is done or broken. */
static void relay(int a, int b) {
  struct channel ch[2] = {
      {.rd = a, .wr = b, .len = 0, .rd_open = 1, .wr_open = 1},
      {.rd = b, .wr = a, .len = 0, .rd_open = 1, .wr_open = 1},
  };
  if (set_nonblocking(a) != 0 || set_nonblocking(b) != 0) return;

  for (;;) {
    struct pollfd pf[4];
    struct channel *owner[4];
    int reading[4];
    int nfds = 0;

    for (int i = 0; i < 2; i++) {
      struct channel *c = &ch[i];
      if (c->rd_open && c->len < sizeof c->buf) {
        pf[nfds].fd = c->rd;
        pf[nfds].events = POLLIN;
        pf[nfds].revents = 0;
        owner[nfds] = c;
        reading[nfds] = 1;
        nfds++;
      }
      if (c->len > 0) {
        pf[nfds].fd = c->wr;
        pf[nfds].events = POLLOUT;
        pf[nfds].revents = 0;
        owner[nfds] = c;
        reading[nfds] = 0;
        nfds++;
      }
    }
    if (nfds == 0) break;

    int rc = poll(pf, (nfds_t)nfds, -1);
    if (rc < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (rc == 0) continue;

    int broken = 0;
    for (int i = 0; i < nfds && !broken; i++) {
      if (pf[i].revents == 0) continue;
      struct channel *c = owner[i];
      if (reading[i]) {
        ssize_t n = read(c->rd, c->buf + c->len, sizeof c->buf - c->len);
        if (n > 0) {
          c->len += (size_t)n;
        } else if (n == 0) {
          c->rd_open = 0;
        } else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
          broken = 1;
        }
      } else {
        ssize_t n = write(c->wr, c->buf, c->len);
        if (n > 0) {
          memmove(c->buf, c->buf + n, c->len - (size_t)n);
          c->len -= (size_t)n;
        } else if (n < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
          broken = 1;
        }
      }
    }
    if (broken) break;

    for (int i = 0; i < 2; i++) {
      if (!ch[i].rd_open && ch[i].len == 0) shutdown_wr(&ch[i]);
    }
  }
}

int main(void) {
  /* A closed peer is normal here; only the VM's exit should end this process. */
  signal(SIGPIPE, SIG_IGN);
  signal(SIGCHLD, SIG_IGN);

  const uint32_t vsock_port = (uint32_t)env_port("HIVE_VSOCK_PORT", DEFAULT_VSOCK_PORT);
  const int listen_port = env_port("HIVE_NETD_PORT", DEFAULT_LISTEN_PORT);

  int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0) {
    fprintf(stderr, "hive-netd: socket: %s\n", strerror(errno));
    return 1;
  }
  int one = 1;
  (void)setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons((uint16_t)listen_port);
  if (bind(listener, (struct sockaddr *)&addr, sizeof addr) != 0) {
    fprintf(stderr, "hive-netd: bind 127.0.0.1:%d: %s\n", listen_port, strerror(errno));
    return 1;
  }
  if (listen(listener, 128) != 0) {
    fprintf(stderr, "hive-netd: listen: %s\n", strerror(errno));
    return 1;
  }

  for (;;) {
    int client = accept(listener, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR || errno == ECONNABORTED) continue;
      fprintf(stderr, "hive-netd: accept: %s\n", strerror(errno));
      continue;
    }
    pid_t pid = fork();
    if (pid < 0) {
      close(client);
      continue;
    }
    if (pid > 0) {
      close(client);
      continue;
    }
    close(listener);
    int upstream = vsock_connect(vsock_port);
    if (upstream < 0) _exit(1);
    relay(client, upstream);
    close(client);
    close(upstream);
    _exit(0);
  }
}
