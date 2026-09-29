"""Read the small BIFF8 .xls order export from Ctrip without external packages.

Only the first worksheet's cell values are read. Formulas, formatting and macros
are ignored. Unrecognized layouts are rejected instead of guessing inventory.
"""
import base64
import re
import struct
from datetime import datetime

SIGNATURE = bytes.fromhex('d0cf11e0a1b11ae1')
END = 0xfffffffe
FREE = 0xffffffff
EXPECTED = ('订单号', '订单状态', '房型名称', '入住日期', '离店日期', '房间数', '预订网站')


def _u16(data, off):
    return struct.unpack_from('<H', data, off)[0]


def _u32(data, off):
    return struct.unpack_from('<I', data, off)[0]


def _compound_stream(data):
    if len(data) < 512 or data[:8] != SIGNATURE:
        raise ValueError('请选择携程导出的 .xls 订单文件')
    sector_size = 1 << _u16(data, 30)
    if sector_size not in (512, 4096) or len(data) > 10_000_000:
        raise ValueError('订单文件格式或大小不正确')

    def sector(sid):
        pos = (sid + 1) * sector_size
        if sid >= 0xfffffffa or pos + sector_size > len(data):
            raise ValueError('订单文件内容不完整')
        return data[pos:pos + sector_size]

    difat = list(struct.unpack_from('<109I', data, 76))
    sid = _u32(data, 68)
    for _ in range(_u32(data, 72)):
        block = sector(sid)
        difat += list(struct.unpack_from('<' + 'I' * (sector_size // 4 - 1), block))
        sid = _u32(block, sector_size - 4)
    fat_sectors = [x for x in difat if x != FREE]
    if len(fat_sectors) < _u32(data, 44):
        raise ValueError('订单文件分配表不完整')
    fat = []
    for x in fat_sectors[:_u32(data, 44)]:
        fat.extend(struct.unpack('<' + 'I' * (sector_size // 4), sector(x)))

    def chain(first, maximum=100000):
        seen = set()
        while first != END:
            if first in seen or first >= len(fat) or len(seen) >= maximum:
                raise ValueError('订单文件分配表损坏')
            seen.add(first)
            yield first
            first = fat[first]

    directory = b''.join(sector(x) for x in chain(_u32(data, 48), 512))
    entries = []
    for off in range(0, len(directory) - 127, 128):
        name_len = _u16(directory, off + 64)
        if not 2 <= name_len <= 64:
            continue
        name = directory[off:off + name_len - 2].decode('utf-16le', errors='replace')
        entries.append((name, directory[off + 66], _u32(directory, off + 116), struct.unpack_from('<Q', directory, off + 120)[0]))
    target = next((e for e in entries if e[1] == 2 and e[0] in ('Workbook', 'Book')), None)
    if not target or target[3] > 10_000_000:
        raise ValueError('文件中找不到 Excel 订单工作簿')
    if target[3] >= _u32(data, 56):
        return b''.join(sector(x) for x in chain(target[2], 20000))[:target[3]]

    # Small workbook streams use the OLE mini stream.
    root = next((e for e in entries if e[1] == 5), None)
    if not root:
        raise ValueError('订单文件迷你流不完整')
    mini_fat_data = b''.join(sector(x) for x in chain(_u32(data, 60), 20000))
    mini_fat = struct.unpack('<' + 'I' * (len(mini_fat_data) // 4), mini_fat_data)
    mini_data = b''.join(sector(x) for x in chain(root[2], 20000))[:root[3]]
    parts, seen, current = [], set(), target[2]
    while current != END:
        if current in seen or current >= len(mini_fat):
            raise ValueError('订单文件迷你流损坏')
        seen.add(current)
        parts.append(mini_data[current * 64:(current + 1) * 64])
        current = mini_fat[current]
    return b''.join(parts)[:target[3]]


class _Segments:
    def __init__(self, parts):
        self.parts, self.index, self.pos = parts, 0, 0

    def raw(self, count):
        result = bytearray()
        while count:
            if self.index >= len(self.parts):
                raise ValueError('订单文字内容不完整')
            part = self.parts[self.index]
            if self.pos == len(part):
                self.index += 1
                self.pos = 0
                continue
            amount = min(count, len(part) - self.pos)
            result.extend(part[self.pos:self.pos + amount])
            self.pos += amount
            count -= amount
        return bytes(result)

    def chars(self, count, wide):
        result = []
        while count:
            if self.index >= len(self.parts):
                raise ValueError('订单文字内容不完整')
            part = self.parts[self.index]
            if self.pos == len(part):
                self.index += 1
                self.pos = 0
                if self.index >= len(self.parts) or not self.parts[self.index]:
                    raise ValueError('订单文字内容不完整')
                wide = bool(self.parts[self.index][0] & 1)
                self.pos = 1
                continue
            width = 2 if wide else 1
            amount = min(count, (len(part) - self.pos) // width)
            if not amount:
                raise ValueError('订单文字编码不完整')
            chunk = part[self.pos:self.pos + amount * width]
            result.append(chunk.decode('utf-16le' if wide else 'latin1'))
            self.pos += amount * width
            count -= amount
        return ''.join(result)


def _sst(parts):
    stream = _Segments([parts[0][8:]] + parts[1:])
    count = _u32(parts[0], 4)
    if count > 100000:
        raise ValueError('订单文件文字表过大')
    values = []
    for _ in range(count):
        length = _u16(stream.raw(2), 0)
        flags = stream.raw(1)[0]
        rich = _u16(stream.raw(2), 0) if flags & 8 else 0
        extra = _u32(stream.raw(4), 0) if flags & 4 else 0
        values.append(stream.chars(length, bool(flags & 1)))
        stream.raw(rich * 4 + extra)
    return values


def read_cells(data):
    book = _compound_stream(data)
    records, offset = [], 0
    while offset + 4 <= len(book):
        kind, size = struct.unpack_from('<HH', book, offset)
        offset += 4
        if offset + size > len(book):
            raise ValueError('订单文件记录不完整')
        records.append((kind, book[offset:offset + size]))
        offset += size
    sst = []
    for i, (kind, payload) in enumerate(records):
        if kind == 0x00fc:
            parts = [payload]
            for follow, value in records[i + 1:]:
                if follow != 0x003c:
                    break
                parts.append(value)
            sst = _sst(parts)
            break
    rows = {}
    in_sheet = False
    for kind, value in records:
        if kind == 0x0809 and len(value) >= 4:
            in_sheet = _u16(value, 2) == 0x0010
        elif kind == 0x000a and in_sheet:
            break
        if not in_sheet or len(value) < 6:
            continue
        if kind == 0x00fd and len(value) >= 10:
            row, col, _, index = struct.unpack_from('<HHHI', value)
            if index >= len(sst):
                raise ValueError('订单文件文字索引不正确')
            rows.setdefault(row, {})[col] = sst[index]
        elif kind == 0x0204 and len(value) >= 8:
            row, col, _, length = struct.unpack_from('<HHHH', value)
            rows.setdefault(row, {})[col] = value[8:8 + length].decode('latin1')
        elif kind == 0x0203 and len(value) >= 14:
            row, col = struct.unpack_from('<HH', value)
            rows.setdefault(row, {})[col] = struct.unpack_from('<d', value, 6)[0]
    if not rows:
        raise ValueError('订单文件没有可读取的表格数据')
    return [[cells.get(col, '') for col in range(max(cells) + 1)] for _, cells in sorted(rows.items())]


def parse_export(encoded):
    if not isinstance(encoded, str) or len(encoded) > 14_000_000:
        raise ValueError('订单文件太大')
    try:
        data = base64.b64decode(encoded, validate=True)
        rows = read_cells(data)
    except (struct.error, UnicodeError, ValueError) as exc:
        raise ValueError('无法读取携程 .xls 订单文件；请确认是原始导出文件') from exc
    headers = [str(v).strip() for v in rows[0]]
    if any(headers.count(name) != 1 for name in EXPECTED):
        raise ValueError('订单表缺少订单号、房型、日期、房间数或状态列')
    index = {name: headers.index(name) for name in EXPECTED}
    if '客人姓名' in headers:
        index['客人姓名'] = headers.index('客人姓名')
    orders = []
    seen = {}
    for row_no, row in enumerate(rows[1:], 2):
        get = lambda name: str(row[index[name]] if index[name] < len(row) else '').strip()
        raw_id = get('订单号')
        if not raw_id:
            continue
        numeric = re.fullmatch(r'(\d{12,20})[^\d]*', raw_id)
        order_id = numeric.group(1) if numeric else raw_id
        if len(order_id) > 100:
            raise ValueError(f'订单表第 {row_no} 行的订单号过长')
        product, status, site = get('房型名称'), get('订单状态'), get('预订网站')
        if not product or len(product) > 120 or len(status) > 30 or len(site) > 30:
            raise ValueError(f'订单表第 {row_no} 行的房型或状态不正确')
        try:
            quantity = int(get('房间数'))
            start = datetime.strptime(get('入住日期'), '%Y年%m月%d日').date()
            end = datetime.strptime(get('离店日期'), '%Y年%m月%d日').date()
        except (ValueError, TypeError) as exc:
            raise ValueError(f'订单表第 {row_no} 行的日期或房间数不正确') from exc
        if not 1 <= quantity <= 13 or not 1 <= (end - start).days <= 365:
            raise ValueError(f'订单表第 {row_no} 行的房间数或住宿日期超出范围')
        if not status or not site or len(order_id) < 4 or not all(ch.isprintable() for ch in order_id):
            raise ValueError(f'订单表第 {row_no} 行的订单号、状态或网站不正确')
        guest = get('客人姓名') if '客人姓名' in headers else ''
        if len(guest) > 60 or any(not ch.isprintable() for ch in guest):
            raise ValueError(f'订单表第 {row_no} 行的客人姓名格式不正确')
        order = dict(id=order_id, product=product, site=site, status=status,
                     start=start.isoformat(), end=end.isoformat(), quantity=quantity, guest=guest)
        if order_id in seen:
            if seen[order_id] != order:
                raise ValueError(f'订单表第 {row_no} 行的订单号重复，但内容不同，请在携程核对后重新导出')
            continue
        seen[order_id] = order
        orders.append(order)
    if not orders or len(orders) > 5000:
        raise ValueError('订单表没有有效订单或订单数量过多')
    return orders
