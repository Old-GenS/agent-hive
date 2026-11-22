#!/bin/sh
# This file is copied into the read-only rootfs image as /run.sh. It mounts the
# "scripts" share and runs the guest script selected by GUEST_SCRIPT (default
# guest.sh, which the harness makes a copy or symlink of).
mount -t virtiofs scripts /mnt/scripts
exec /bin/sh "/mnt/scripts/${GUEST_SCRIPT:-guest.sh}"
