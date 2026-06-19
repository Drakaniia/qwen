import yt_dlp_dependencies as _dependencies

PROJECT_ROOT = _dependencies.PROJECT_ROOT
LOCAL_ARIA2C = _dependencies.LOCAL_ARIA2C
LOCAL_N_M3U8DL_RE = _dependencies.LOCAL_N_M3U8DL_RE


def get_imageio_ffmpeg_exe():
    return _dependencies.get_imageio_ffmpeg_exe()


def resolve_yt_dlp_command():
    return _dependencies.resolve_yt_dlp_command()


def resolve_ffmpeg_location(imageio_resolver=None):
    return _dependencies.resolve_ffmpeg_location(imageio_resolver=imageio_resolver or get_imageio_ffmpeg_exe)


def resolve_aria2c_location(local_aria2c=None):
    return _dependencies.resolve_aria2c_location(local_aria2c=LOCAL_ARIA2C if local_aria2c is None else local_aria2c)


def require_aria2c_location(local_aria2c=None):
    return _dependencies.require_aria2c_location(local_aria2c=LOCAL_ARIA2C if local_aria2c is None else local_aria2c)


def resolve_n_m3u8dl_re_location(local_n_m3u8dl_re=None):
    return _dependencies.resolve_n_m3u8dl_re_location(
        local_n_m3u8dl_re=LOCAL_N_M3U8DL_RE if local_n_m3u8dl_re is None else local_n_m3u8dl_re
    )


def resolve_streamlink_command():
    return _dependencies.resolve_streamlink_command()


def has_yt_dlp():
    return _dependencies.has_yt_dlp()


def has_ffmpeg(imageio_resolver=None):
    return _dependencies.has_ffmpeg(imageio_resolver=imageio_resolver or get_imageio_ffmpeg_exe)


def has_aria2c(local_aria2c=None):
    return _dependencies.has_aria2c(local_aria2c=LOCAL_ARIA2C if local_aria2c is None else local_aria2c)


def has_n_m3u8dl_re(local_n_m3u8dl_re=None):
    return _dependencies.has_n_m3u8dl_re(
        local_n_m3u8dl_re=LOCAL_N_M3U8DL_RE if local_n_m3u8dl_re is None else local_n_m3u8dl_re
    )


def has_streamlink():
    return _dependencies.has_streamlink()


def require_executable(name, install_hint):
    found = _dependencies.shutil.which(name)
    if not found:
        from native_protocol import HostError

        raise HostError(f"{name} is not installed or is not on PATH. {install_hint}")
    return found
