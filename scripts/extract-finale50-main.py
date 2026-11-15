#!/usr/bin/env python3
"""Copy only 主视觉.png from the original finale archive into a new file."""

import argparse
from pathlib import Path, PurePosixPath
import stat
import struct
import sys
from zipfile import BadZipFile, ZipFile
from zlib import crc32


NAME = "主视觉.png"
MAX_BYTES = 64 * 1024 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def filename(info):
    value = info.filename
    if not info.flag_bits & 0x800:
        try:
            value = value.encode("cp437").decode("gb18030")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return value.replace("\\", "/")


def png_size(data):
    if data[:16] != PNG_MAGIC + b"\x00\x00\x00\rIHDR":
        raise ValueError("「主视觉.png」缺少有效的 PNG 文件头。")
    width, height = struct.unpack_from(">II", data, 16)
    if not (0 < width <= 8192 and 0 < height <= 8192 and width * height <= 36_000_000):
        raise ValueError("「主视觉.png」尺寸无效或过大。")
    view = memoryview(data)
    offset = len(PNG_MAGIC)
    pixels = False
    while offset + 12 <= len(view):
        length, kind = struct.unpack_from(">I4s", view, offset)
        end = offset + 8 + length
        if end + 4 > len(view) or crc32(view[offset + 4:end]) != struct.unpack_from(">I", view, end)[0]:
            break
        if kind == b"IDAT":
            pixels = True
        if kind == b"IEND":
            if length == 0 and pixels and end + 4 == len(view):
                return width, height
            break
        offset = end + 4
    raise ValueError("「主视觉.png」损坏或不完整。")


def extract(source, destination):
    with ZipFile(source) as archive:
        candidates = [
            info for info in archive.infolist()
            if PurePosixPath(filename(info)).name == NAME and not info.is_dir()
        ]
        if len(candidates) != 1:
            raise ValueError("未找到唯一的「主视觉.png」，没有写入文件。")
        info = candidates[0]
        if stat.S_IFMT(info.external_attr >> 16) not in (0, stat.S_IFREG):
            raise ValueError("「主视觉.png」不是普通文件。")
        if not 33 <= info.file_size <= MAX_BYTES:
            raise ValueError("「主视觉.png」大小无效或超过 64 MiB。")
        with archive.open(info) as stream:
            data = stream.read(MAX_BYTES + 1)
        if len(data) != info.file_size:
            raise ValueError("「主视觉.png」不是有效的 PNG 文件。")
        width, height = png_size(data)

    if destination.suffix.lower() != ".png":
        raise ValueError("输出请使用 .png 文件名。")
    # The caller picks the output file. Never extract an archive-provided path.
    with destination.open("xb") as output:
        output.write(data)
    return width, height


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="原来的「冬天歌会.zip」")
    parser.add_argument("output", type=Path, help="要新建的 PNG 文件路径（不能已存在）")
    args = parser.parse_args()
    try:
        width, height = extract(args.archive, args.output)
    except FileExistsError:
        parser.exit(1, "输出文件已存在，没有覆盖。\n")
    except (BadZipFile, OSError, ValueError, RuntimeError, NotImplementedError) as exc:
        print(f"提取失败：{exc}", file=sys.stderr)
        return 1
    print(f"已提取 {width}×{height} 主视觉：{args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
