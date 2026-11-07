// getfd(pid, fd): a copy, in this process, of another process's file descriptor (pidfd_open + pidfd_getfd; the
// other process must be our child, or allow us, under Yama's ptrace scope)
#include <node_api.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static napi_value getfd(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t pid = 0, fd = 0;
  napi_get_value_int32(env, argv[0], &pid); napi_get_value_int32(env, argv[1], &fd);
  int pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
  if (pidfd < 0) { char m[96]; snprintf(m, sizeof m, "pidfd_open(%d): %s", pid, strerror(errno)); napi_throw_error(env, NULL, m); return NULL; }
  int local = (int)syscall(SYS_pidfd_getfd, pidfd, fd, 0);
  int e = errno; close(pidfd);
  if (local < 0) { char m[96]; snprintf(m, sizeof m, "pidfd_getfd(%d, %d): %s", pid, fd, strerror(e)); napi_throw_error(env, NULL, m); return NULL; }
  napi_value r; napi_create_int32(env, local, &r); return r;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "getfd", NAPI_AUTO_LENGTH, getfd, NULL, &fn);
  napi_set_named_property(env, exports, "getfd", fn);
  return exports;
}
