#!/usr/bin/env python3
"""Scan image files for metadata that should not ship with the public repo.

Scans JPEG (EXIF/XMP/ICC/Photoshop/COM), PNG (tEXt/iTXt/zTXt), WebP
(EXIF/XMP/MP7) and the filesystem's own resource fork (Apple "ControlFork",
which is where macOS stores Spotlight tags and comments).

Exit code 0 = clean, 1 = something found. Nothing is modified here -- see
tools/strip_metadata.py to remove it.

Usage:
  tools/check_metadata.py assets/artwork/
"""
import os
import struct
import sys

def read_uint16(buf, off):
    return struct.unpack_from('>H', buf, off)[0]

def read_uint32(buf, off):
    return struct.unpack_from('>I', buf, off)[0]


def scan_jpeg(buf):
    """Return {marker_name: byte_count} plus decoded EXIF tags."""
    found = {}
    exif_tags = {}
    i = 2  # skip SOI
    while i < len(buf):
        if buf[i] != 0xFF:
            break
        marker = buf[i + 1]
        if marker in (0xD8, 0xD9):
            i += 2
            continue
        if marker == 0xFF or marker == 0x00:
            i += 1
            continue
        if marker == 0xDA:  # start of scan: entropy data follows, no length
            break
        if marker in (0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7):
            i += 2
            continue
        seglen = read_uint16(buf, i + 2)
        # marker segment = FF <marker> <2-byte length> <payload>, so the payload
        # starts at i + 4 (the length counts itself)
        name = 'APP0' if marker == 0xE0 else 'APP1' if marker == 0xE1 else 'APP2' if marker == 0xE2 else 'COM' if marker == 0xFE else 'APP%d' % (marker - 0xE0)
        seg = buf[i + 4:i + 2 + seglen]
        if marker == 0xE1:
            exif_tags.update(decode_exif(seg))
            found['EXIF/XMP'] = found.get('EXIF/XMP', 0) + seglen
        elif name in ('APP2', 'APP13', 'APP12'):
            found[name] = found.get(name, 0) + seglen
        elif marker == 0xFE:
            found['COM'] = found.get('COM', 0) + seglen
        i += 2 + seglen
    return found, exif_tags


KNOWN_EXIF_TAGS = {
    0x010F: 'ImageDescription',
    0x0110: 'Make',
    0x0112: 'Model',
    0x0131: 'Software',
    0x013B: 'Artist',
    0x013E: 'Copyright',
    0x8769: 'ExifIFD-pointer',
    0x8825: 'GPSIFD-pointer',
    0x9003: 'DateTimeOriginal',
    0x9004: 'DateTimeDigitized',
    0x882A: 'Author',
    0x9211: 'SourceFactory',
    0x9212: 'SourceModel',
    0x0213: 'Author',
    0x0122: 'Rating',
    0x8298: 'Publisher',
}


def decode_exif(seg):
    """Decode IFD0 tags (and flag GPS presence) from an APP1 EXIF payload."""
    if not seg.startswith(b'Exif\x00\x00'):
        return {'XMP': 'xmp packet'}
    body = seg[6:]
    endian = '<' if body[:2] == b'II' else '>'
    ifd_off = struct.unpack_from(endian + 'I', body, 4)[0]
    out = {}
    def read_ifd(start):
        count = struct.unpack_from(endian + 'H', body, start)[0]
        for n in range(count):
            e = start + 2 + n * 12
            tag = struct.unpack_from(endian + 'H', body, e)[0]
            typ = struct.unpack_from(endian + 'H', body, e + 2)[0]
            size = struct.unpack_from(endian + 'I', body, e + 4)[0]
            name = KNOWN_EXIF_TAGS.get(tag)
            if not name:
                continue
            if size <= 4:
                val = body[e + 8:e + 8 + size]
            else:
                val_off = struct.unpack_from(endian + 'I', body, e + 8)[0]
                val = body[val_off:val_off + size]
            val = val.rstrip(b'\x00').decode('utf-8', 'replace')
            if val:
                out[name] = val
    read_ifd(ifd_off)
    for tag, label in ((0x8769, 'ExifSubIFD'), (0x8825, 'GPS')):
        # re-scan IFD0 for the pointer value
        count = struct.unpack_from(endian + 'H', body, ifd_off)[0]
        for n in range(count):
            e = ifd_off + 2 + n * 12
            if struct.unpack_from(endian + 'H', body, e)[0] == tag:
                out[label] = 'present (%d entries)' % struct.unpack_from(endian + 'H', body, struct.unpack_from(endian + 'I', body, e + 8)[0])
    return out


def scan_png(buf):
    found = {}
    i = 8
    while i < len(buf):
        size = read_uint32(buf, i)
        ctype = buf[i + 4:i + 8].decode('ascii', 'replace')
        if ctype in ('tEXt', 'iTXt', 'zTXt'):
            data = buf[i + 8:i + 8 + size]
            found[ctype] = found.get(ctype, 0) + size
            # print keyword=value for tEXt
            if ctype == 'tEXt':
                kw, _, val = data.partition(b'\x00')
                found.setdefault('keys', []).append(kw.decode('latin-1'))
        i += 12 + size
    return found


def scan_webp(buf):
    found = {}
    i = 12
    while i + 8 <= len(buf):
        fourcc = buf[i:i + 4].decode('ascii', 'replace')
        size = read_uint32(buf, i + 4)
        if fourcc in ('EXIF', 'XMP ', 'MP7L'):
            found[fourcc.strip()] = size
        i += 8 + size + (size % 2)
    return found


def scan(path):
    buf = open(path, 'rb').read()
    tags = {}
    if buf[:3] == b'\xff\xd8\xff':
        found, tags = scan_jpeg(buf)
    elif buf[:8] == b'\x89PNG\r\n\x1a\n':
        found = scan_png(buf)
    elif buf[:4] == b'RIFF' and buf[8:12] == b'WEBP':
        found = scan_webp(buf)
    else:
        return {'not-an-image': True}
    return {'segments': found, 'tags': tags}


def report(p, r):
    segs = r.get('segments') or {}
    tags = r.get('tags') or {}
    if segs or tags:
        print('METADATA  %s' % p)
        for k, v in segs.items():
            if k == 'keys':
                print('   %s: %s' % (k, ', '.join(v)))
            else:
                print('   %s: %d bytes' % (k, v))
        for k, v in tags.items():
            print('   tag %s: %s' % (k, v))
        return True
    print('clean     %s' % p)
    return False


def main(argv):
    paths = argv or []
    dirty = 0
    for path in paths:
        for dirpath, dirnames, filenames in os.walk(path):
            for f in sorted(filenames):
                p = os.path.join(dirpath, f)
                if not os.path.isfile(p):
                    continue
                if f.startswith('._'):
                    dirty += 1
                    print('METADATA  %s (macOS resource fork sidecar, delete)' % p)
                    continue
                r = scan(p)
                if r.get('not-an-image'):
                    continue
                if report(p, r):
                    dirty += 1
    return 1 if dirty else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
