"""KASHO front desk: standard-library-only, loopback HTTP + SQLite."""
import argparse
from collections import Counter
import csv
import io
import json
import os
import sqlite3
import sys
import threading
import webbrowser
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from ctrip_xls import parse_export
from inventory import active_order, alerts as inventory_alerts, snapshot as inventory_snapshot, validate_imported, week_inventory

ROOMS = {'标准间': ['8302', '8802', '8806', '8808'], '大床房': ['8306', '8308'], '高级观景': ['8801'], '舒适观景': ['8303', '8305', '8307', '8803', '8805', '8807']}
ROOM_TYPE = {r: t for t, rooms in ROOMS.items() for r in rooms}
CHANNELS = ['携程', '美团', '线下']
STATUSES = ['预订', '在住', '已退房', '已取消', '停用']

def today():
    return date.today().isoformat()

def now():
    return datetime.now().isoformat(timespec='seconds')

def day(value):
    try:
        result = date.fromisoformat(str(value))
        if result.isoformat() != value:
            raise ValueError()
        return result
    except (ValueError, TypeError):
        raise ValueError('日期格式不正确')

def money(value):
    try:
        n = Decimal(str(value))
        if not n.is_finite() or n < 0 or n > 1000000 or n.as_tuple().exponent < -2:
            raise InvalidOperation()
        return int(n * 100)
    except (InvalidOperation, ValueError):
        raise ValueError('金额须为 0 到 100 万元之间、最多两位小数的数字')

def bounded_text(value, limit):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError('文本内容过长或格式不正确')
    return value.strip()

def validate_booking(b):
    if b.get('room') not in ROOM_TYPE or b.get('channel') not in CHANNELS or b.get('status') not in STATUSES:
        raise ValueError('房间、渠道或状态不正确')
    nights = (day(b['end']) - day(b['start'])).days
    if not 1 <= nights <= 365:
        raise ValueError('离店日期必须晚于入住日期，单笔最多 365 晚')
    if b['status'] in ['在住', '已退房'] and b['start'] > today():
        raise ValueError('未来的订单请登记为预订')
    if b['status'] == '已退房' and b['end'] > max(today(), (day(b['start']) + timedelta(days=1)).isoformat()):
        raise ValueError('请把提前离店日期改为实际离店日')
    for key, limit in [('guest', 60), ('phone', 30), ('reference', 100), ('notes', 1000)]:
        b[key] = bounded_text(b.get(key, ''), limit)
    if not b['guest']:
        raise ValueError('请填写客人称呼；停用时填写原因')
    for key in ['total', 'rate']:
        if type(b.get(key)) is not int or not 0 <= b[key] <= 100000000:
            raise ValueError('金额格式不正确')
    if b['status'] == '停用' and (b['total'] or b['rate']):
        raise ValueError('停用房间的金额应为零')
    if 'releasedOn' in b:
        if b['status'] != '已退房' or not day(b['start']) <= day(b['releasedOn']) <= date.today():
            raise ValueError('退房日期不正确')
    if 'otaOrderId' in b and (not isinstance(b['otaOrderId'], str) or not 4 <= len(b['otaOrderId']) <= 100):
        raise ValueError('关联的携程订单号不正确')
    if b.get('quick'):
        if b['quick'] is not True or type(b.get('guestPaid')) is not int or not 0 <= b['guestPaid'] <= 100000000:
            raise ValueError('客人已付金额不正确')
    if 'paymentStatus' in b or 'roomCharge' in b:
        if b.get('paymentStatus') not in ['已付', '未付'] or type(b.get('roomCharge')) is not int or not 0 <= b['roomCharge'] <= 100000000:
            raise ValueError('房费或付款状态不正确')
        if not b.get('quick') or b['guestPaid'] != (b['roomCharge'] if b['paymentStatus'] == '已付' else 0):
            raise ValueError('已付金额与付款状态不一致')
        if b['status'] == '停用' and b['roomCharge']:
            raise ValueError('停用房间不能登记房费')
    if 'deletedAt' in b:
        if not isinstance(b['deletedAt'], str):
            raise ValueError('删除标记不正确')
        datetime.fromisoformat(b['deletedAt'])
    return b

def occupied_end(b):
    if b.get('releasedOn'):
        return min(b['end'], b['releasedOn'])
    return b['end']

def collision(bookings, proposed):
    if proposed.get('deletedAt') or proposed['status'] == '已取消':
        return None
    if proposed['start'] >= occupied_end(proposed):
        return None
    return next((b for b in bookings if not b.get('deletedAt') and b['id'] != proposed.get('id') and b['room'] == proposed['room'] and b['status'] != '已取消' and b['start'] < occupied_end(b) and b['start'] < occupied_end(proposed) and proposed['start'] < occupied_end(b)), None)

def available(bookings, d, kind):
    return len(ROOMS[kind]) - len({b['room'] for b in bookings if not b.get('deletedAt') and ROOM_TYPE[b['room']] == kind and b['status'] != '已取消' and b['start'] <= d < occupied_end(b)})

def allocation(bookings, settings, overrides, d, kind):
    free = available(bookings, d, kind)
    custom = overrides.get(d + '|' + kind)
    if custom:
        # Preserve explicit offline hold first; shrink online quotas as occupancy changes.
        reserve = min(free, custom['offline'])
        ctrip = min(custom['ctrip'], free - reserve)
        meituan = min(custom['meituan'], free - reserve - ctrip)
        reserve = free - ctrip - meituan
    else:
        reserve = min(settings['reserve'][kind], free)
        online = free - reserve
        ctrip, meituan = (online + 1) // 2, online // 2
    return {'free': free, 'ctrip': ctrip, 'meituan': meituan, 'offline': reserve}

def change_quick_booking(s, old, action, data):
    """Build a candidate only; the caller validates the complete batch before saving."""
    b = dict(old)
    if action == 'delete':
        if b.get('deletedAt'):
            raise ValueError('这条记录已经删除')
        b['deletedAt'] = now()
        note = f'删除误录 #{b["id"]} · {b["room"]} · 可恢复；不执行退款'
    elif action == 'restore':
        if not b.get('deletedAt'):
            raise ValueError('这条记录没有被删除')
        b.pop('deletedAt')
        note = f'恢复记录 #{b["id"]} · {b["room"]}'
    else:
        if b.get('deletedAt'):
            raise ValueError('请先恢复这条记录再编辑')
        original_nights = (day(b['end']) - day(b['start'])).days
        duration = data.get('nights', original_nights)
        if type(duration) is not int or not (1 <= duration <= 7 or duration == original_nights):
            raise ValueError('请选择 1 到 7 晚')
        start = data.get('date', b['start'])
        if day(start) > date.today()+timedelta(days=6) and start != old['start']:
            raise ValueError('新的入住日期最远可选今天起一周内；历史日期可以更正')
        ledger_paid = sum(p['amount'] for p in s['payments'] if p['bookingId'] == b['id'])
        old_paid = old.get('guestPaid', ledger_paid)
        charge = money(data['amount']) if 'amount' in data else old.get('roomCharge', old_paid)
        payment_status = data.get('paymentStatus', old.get('paymentStatus', '已付'))
        if payment_status not in ['已付', '未付']:
            raise ValueError('请选择已付或未付')
        paid = charge if payment_status == '已付' else 0
        status = data.get('status', b['status'])
        if (old['status'] == '停用') != (status == '停用') and status != '已取消':
            raise ValueError('停用记录不能转为客人入住，请另行登记')
        b.update(room=data.get('room', b['room']), channel=data.get('channel', b['channel']), notes=data.get('notes', b.get('notes', '')), start=start,
                 end=(day(start)+timedelta(days=duration)).isoformat(), status=status)
        # Leave monetary metadata unchanged when editing other fields.
        if 'amount' in data or 'paymentStatus' in data or 'paymentStatus' in old:
            b.update(quick=True, guestPaid=paid, roomCharge=charge, paymentStatus=payment_status,
                     total=max(charge, ledger_paid), rate=charge//duration)
        elif b.get('quick') and duration != original_nights:
            b['rate'] = paid//duration
        if status == '已退房':
            if old['status'] != status or start != old['start'] or b['end'] != old['end']:
                b['releasedOn'] = min(b['end'], today())
        else:
            b.pop('releasedOn', None)
            b.pop('checkedOutAt', None)
        b['updatedAt'] = now()
        note = f'编辑记录 #{b["id"]} · {old["room"]}→{b["room"]} · {old["channel"]}→{b["channel"]} · 已付 ¥{old_paid/100:.2f}→¥{paid/100:.2f} · {old["start"]}—{old["end"]}→{b["start"]}—{b["end"]} · {old["status"]}→{b["status"]}'
        if b['notes'] != old.get('notes', ''):
            note += ' · 更新备注'
        if 'paymentStatus' in data or 'paymentStatus' in old:
            note += f' · 房费 ¥{charge/100:.2f} · {payment_status}（仅登记，不执行实际收退款）'
    validate_booking(b)
    if b.get('otaOrderId') and b['status'] != '已取消':
        order = next((o for o in s.get('otaOrders', []) if o['id'] == b['otaOrderId']), None)
        if order and active_order(order) and (ROOM_TYPE[b['room']] != order['kind'] or b['start'] != order['start']
                                               or b['end'] != order['end'] or b['channel'] != ('美团' if order['site'] == '美团' else '携程')):
            raise ValueError('已关联的平台订单房型、日期或渠道不匹配；请先核对订单或解除关联')
    return b, note


def import_preview(state, encoded):
    orders = parse_export(encoded)
    old = {o['id']: o for o in state.get('otaOrders', []) if not o.get('manual')}
    ids = {o['id'] for o in orders}
    return {
        'count': len(orders),
        'new': sum(o['id'] not in old for o in orders),
        'existing': sum(o['id'] in old for o in orders),
        'notInFile': sum(o['id'] not in ids for o in old.values()),
        'products': dict(Counter(o['product'] for o in orders)),
        'sites': dict(Counter(o['site'] for o in orders)),
        'statuses': dict(Counter(o['status'] for o in orders)),
        'firstDate': min(o['start'] for o in orders),
        'lastDate': max(o['end'] for o in orders),
        'roomNights': sum(o['quantity'] * (day(o['end']) - day(o['start'])).days for o in orders if active_order(o)),
    }


def auto_assign_orders(state, imported_ids):
    """Assign only unambiguous future OTA stays; never displace a local booking."""
    assigned = skipped = 0
    orders = sorted((o for o in state['otaOrders'] if o['id'] in imported_ids and active_order(o) and o['end'] > today()),
                    key=lambda o: (o['start'], o['id']))
    for order in orders:
        if order['start'] < today():
            skipped += order['quantity']
            continue
        related = [b for b in state['bookings'] if b.get('otaOrderId') == order['id'] and not b.get('deletedAt') and b['status'] != '已取消']
        valid = [b for b in related if b['start'] == order['start'] and b['end'] == order['end'] and b['room'] in ROOMS[order['kind']]]
        remaining = max(0, order['quantity'] - len(valid))
        if not remaining:
            continue
        channel = '美团' if order['site'] == '美团' else '携程'
        # A changed platform order or a manually entered, unlinked stay needs human matching.
        if len(valid) != len(related) or any(
            not b.get('deletedAt') and b['status'] != '已取消' and not b.get('otaOrderId')
            and b['channel'] == channel and b['room'] in ROOMS[order['kind']]
            and b['start'] == order['start'] and b['end'] == order['end']
            for b in state['bookings']
        ):
            skipped += remaining
            continue
        for _ in range(remaining):
            booking = dict(id=state['nextId'], room='', channel=channel, status='预订',
                           guest='未留姓名', phone='', reference='', notes=order.get('guest') or '姓名待核对',
                           start=order['start'], end=order['end'], rate=0, total=0, created=now(),
                           quick=True, guestPaid=0, paymentStatus='未付', roomCharge=0,
                           otaOrderId=order['id'], autoAssigned=True)
            target = next((room for room in ROOMS[order['kind']]
                           if not collision(state['bookings'], dict(booking, room=room))), None)
            if not target:
                skipped += 1
                continue
            booking['room'] = target
            validate_booking(booking)
            state['bookings'].append(booking)
            state['nextId'] += 1
            assigned += 1
    return assigned, skipped


def served_state(state):
    return dict(state, rooms=ROOMS, today=today(), app='kasho-frontdesk',
                inventory=week_inventory(state, today(), ROOMS), closureAlerts=inventory_alerts(state, today(), ROOMS))


class Store:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.backups = self.folder / 'backups'
        self.backups.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.folder / 'frontdesk.sqlite3', check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)')
        state = {'schema': 1, 'revision': 0, 'bookings': [], 'payments': [], 'settings': {'reserve': {k: 0 for k in ROOMS}, 'rates': {k: 0 for k in ROOMS}}, 'overrides': {}, 'confirmed': {}, 'audit': [], 'nextId': 1, 'otaOrders': [], 'platformChecks': {}}
        self.db.execute('INSERT OR IGNORE INTO state VALUES (1, ?)', (json.dumps(state, ensure_ascii=False),))
        self.db.commit()

    def read(self):
        with self.lock:
            return json.loads(self.db.execute('SELECT payload FROM state WHERE id=1').fetchone()[0])

    def backup(self):
        path = self.backups / (datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.sqlite3')
        dest = sqlite3.connect(path)
        try:
            self.db.backup(dest)
        finally:
            dest.close()
        # Only rotate this application's own precisely matched backup files.
        snapshots = sorted(self.backups.glob('????????-??????-??????.sqlite3'))
        for old in snapshots[:-100]:
            old.unlink()

    def write(self, action, data):
        with self.lock:
            s = self.read()
            if data.get('revision') != s['revision']:
                raise ValueError('数据已在另一窗口更新，请刷新后再操作')
            s.setdefault('otaOrders', [])
            s.setdefault('platformChecks', {})
            note = action
            if action == 'quick-in':
                room, channel = data.get('room'), data.get('channel')
                if room not in ROOM_TYPE or channel not in CHANNELS:
                    raise ValueError('请选择房间和客源')
                start = data.get('date', today())
                duration = data.get('nights', 1)
                ota_id = data.get('otaOrderId', '')
                ota_order = next((o for o in s['otaOrders'] if o['id'] == ota_id), None) if ota_id else None
                if ota_id:
                    expected_channel = '美团' if ota_order and ota_order['site'] == '美团' else '携程'
                    if not ota_order or not active_order(ota_order) or channel != expected_channel or ROOM_TYPE[room] != ota_order['kind'] or start != ota_order['start'] or (day(start) + timedelta(days=duration)).isoformat() != ota_order['end']:
                        raise ValueError('关联订单的房型、入住日期或住宿晚数不匹配')
                    linked = sum(b.get('otaOrderId') == ota_id and not b.get('deletedAt') and b['status'] != '已取消' for b in s['bookings'])
                    if linked >= ota_order['quantity']:
                        raise ValueError('这笔携程订单的间数已经全部关联房号')
                if type(duration) is not int or not (1 <= duration <= 7 or (ota_order and duration == (day(ota_order['end']) - day(ota_order['start'])).days)):
                    raise ValueError('请选择 1 到 7 晚，或使用导入订单的原住宿晚数')
                if not date.today() <= day(start) <= date.today()+timedelta(days=365 if ota_order else 6):
                    raise ValueError('请选择今天起一周内的入住日期')
                amount = money(data['amount'])
                payment_status = data.get('paymentStatus', '已付')
                if payment_status not in ['已付', '未付']:
                    raise ValueError('请选择已付或未付')
                stamp = now()
                b = dict(id=s['nextId'], room=room, channel=channel, status='在住' if start == today() else '预订', guest='未留姓名', phone='', reference='', notes=bounded_text(data.get('notes', ''), 1000), start=start, end=(day(start)+timedelta(days=duration)).isoformat(), rate=amount//duration, total=amount, created=stamp, quick=True, guestPaid=amount)
                b.update(paymentStatus=payment_status, roomCharge=amount, guestPaid=amount if payment_status == '已付' else 0)
                if ota_id:
                    b['otaOrderId'] = ota_id
                validate_booking(b)
                if collision(s['bookings'], b):
                    raise ValueError('这间房在所选住宿期间已经占用，请换房或减少晚数')
                candidate_state = dict(s, bookings=s['bookings'] + [b])
                for offset in range(duration):
                    lodging_date = (day(start) + timedelta(days=offset)).isoformat()
                    if inventory_snapshot(candidate_state, lodging_date, ROOM_TYPE[room], ROOMS)['free'] < 0:
                        raise ValueError(f'{lodging_date} 的{ROOM_TYPE[room]}已被预订满，请先关联对应携程订单或核对房量')
                s['bookings'].append(b)
                s['nextId'] += 1
                # Guest-paid amount is recorded on the stay, not as hotel cash received.
                # In particular, an OTA guest payment is not a platform settlement.
                note = f'{b["status"]} · {room} · {start} 起 {duration} 晚 · {channel} · 房费 ¥{amount/100:.2f} · {payment_status}'
            elif action == 'quick-move':
                b = next((b for b in s['bookings'] if b['id'] == data.get('bookingId')), None)
                target = data.get('room')
                if not b or b.get('deletedAt') or b['status'] != '预订' or b['start'] < today():
                    raise ValueError('只能给尚未入住的预订换房；已入住记录请逐条核对')
                if target not in ROOM_TYPE or ROOM_TYPE[target] != ROOM_TYPE[b['room']] or target == b['room']:
                    raise ValueError('请选择同房型的另一间房')
                source = b['room']
                moved = dict(b, room=target, updatedAt=now())
                clash = collision(s['bookings'], moved)
                if clash:
                    raise ValueError(f'{target} 在该订单住宿期间已有记录，请选择其他房间')
                b['room'] = target
                b['updatedAt'] = moved['updatedAt']
                note = f'预订换房 #{b["id"]} · {source}→{target} · {b["start"]} 至 {b["end"]}'
            elif action in ['quick-edit', 'quick-delete', 'quick-restore', 'quick-batch']:
                batch = action == 'quick-batch'
                operation = data.get('operation') if batch else action.removeprefix('quick-')
                ids = data.get('bookingIds') if batch else [data.get('bookingId')]
                if operation not in ['edit', 'delete', 'restore']:
                    raise ValueError('批量操作不正确')
                if not isinstance(ids, list) or not 1 <= len(ids) <= 200 or any(type(i) is not int or i < 1 for i in ids) or len(set(ids)) != len(ids):
                    raise ValueError('请选择 1 到 200 条不同的记录')
                changes = data.get('changes', {}) if batch else data
                if batch and operation == 'edit':
                    if not isinstance(changes, dict) or not changes or set(changes) - {'channel', 'amount', 'date', 'nights', 'status', 'paymentStatus'}:
                        raise ValueError('请至少选择一项要批量修改的内容；房号请逐条编辑')
                by_id = {b['id']: b for b in s['bookings']}
                candidates, notes = {}, []
                for bid in ids:
                    old = by_id.get(bid)
                    if not old:
                        raise ValueError('找不到部分记录，请刷新后重新选择')
                    try:
                        candidates[bid], entry = change_quick_booking(s, old, operation, changes)
                        notes.append(entry)
                    except ValueError as e:
                        raise ValueError(f'{old["room"]}（{old["start"]}）: {e}') from e
                proposed = [candidates.get(b['id'], b) for b in s['bookings']]
                for b in candidates.values():
                    clash = collision(proposed, b)
                    if clash:
                        raise ValueError(f'{b["room"]} 与已有记录冲突（{clash["start"]} 至 {clash["end"]}），本次全部未保存，请调整日期或选择范围')
                s['bookings'] = proposed
                note = (f'批量操作 {len(ids)} 条 · ' if batch else '') + '；'.join(notes)
            elif action == 'ota-import':
                orders = parse_export(data.get('file'))
                mapping = data.get('mapping')
                products = {o['product'] for o in orders}
                if not isinstance(mapping, dict) or set(mapping) != products or any(kind not in ROOMS for kind in mapping.values()):
                    raise ValueError('请为导出文件中的每种房型确认对应关系')
                existing = {o['id']: o for o in s['otaOrders']}
                added = changed = 0
                for o in orders:
                    proposed = dict(o, kind=mapping[o['product']])
                    old = existing.get(o['id'])
                    if old:
                        if any(old.get(k) != v for k, v in proposed.items()):
                            changed += 1
                        old.update(proposed)
                    else:
                        s['otaOrders'].append(proposed)
                        added += 1
                assigned, skipped = auto_assign_orders(s, {o['id'] for o in orders})
                s['otaLastImportAt'] = now()
                s['otaLastImportResult'] = {'orders': len(orders), 'new': added, 'changed': changed,
                                            'assigned': assigned, 'skipped': skipped}
                note = f'导入携程订单 {len(orders)} 笔，新增 {added}、更新 {changed}；自动分房 {assigned} 间、待人工核对 {skipped} 间；文件未出现的旧订单保留'
            elif action == 'ota-manual':
                raw_id = bounded_text(data.get('orderId', ''), 80)
                kind, start, end, quantity, status = data.get('kind'), data.get('start'), data.get('end'), data.get('quantity'), data.get('status', '已接单')
                if not raw_id or any(not ch.isprintable() for ch in raw_id) or kind not in ROOMS or status not in ('已接单', '已取消'):
                    raise ValueError('请填写美团订单号、房型和订单状态')
                order_id = 'meituan:' + raw_id
                old = next((o for o in s['otaOrders'] if o['id'] == order_id), None)
                nights = (day(end) - day(start)).days
                if (start < today() and (not old or start != old['start'])) or start > (date.today() + timedelta(days=365)).isoformat() or not 1 <= nights <= 365 or type(quantity) is not int or not 1 <= quantity <= 13:
                    raise ValueError('请选择未来一年内的日期及正确间数')
                if old and not old.get('manual'):
                    raise ValueError('订单号与已有导入订单冲突')
                proposed = dict(id=order_id, site='美团', product='美团手工录入', kind=kind, status=status, start=start, end=end, quantity=quantity, manual=True)
                if old:
                    proposed['manualIgnored'] = old.get('manualIgnored', False)
                    old.update(proposed)
                else:
                    s['otaOrders'].append(proposed)
                note = f'手工{"修改" if old else "登记"}美团未来订单 · {kind} · {start} 至 {end} · {quantity} 间 · {status}'
            elif action == 'ota-link':
                bid, order_id = data.get('bookingId'), data.get('orderId', '')
                b = next((b for b in s['bookings'] if b['id'] == bid), None)
                if not b or b.get('deletedAt') or b['status'] == '已取消' or not b.get('quick'):
                    raise ValueError('请选择一条有效的已登记房号')
                if order_id:
                    order = next((o for o in s['otaOrders'] if o['id'] == order_id), None)
                    expected_channel = '美团' if order and order['site'] == '美团' else '携程'
                    if not order or not active_order(order) or ROOM_TYPE[b['room']] != order['kind'] or b['start'] != order['start'] or b['end'] != order['end'] or b['channel'] != expected_channel:
                        raise ValueError('房号与平台订单的房型、日期或渠道不一致')
                    linked = sum(x.get('otaOrderId') == order_id and x['id'] != bid and not x.get('deletedAt') and x['status'] != '已取消' for x in s['bookings'])
                    if linked >= order['quantity']:
                        raise ValueError('这笔订单的间数已经全部关联房号')
                    b['otaOrderId'] = order_id
                else:
                    b.pop('otaOrderId', None)
                note = f'关联房号 {b["room"]} 与平台订单 {order_id or "已解除"}'
            elif action == 'ota-ignore':
                order = next((o for o in s['otaOrders'] if o['id'] == data.get('orderId')), None)
                ignored = data.get('ignored')
                if not order or type(ignored) is not bool:
                    raise ValueError('请选择需要更正的导入订单')
                order['manualIgnored'] = ignored
                note = f'携程导入订单 {order["id"]} · {"人工确认不计房量" if ignored else "恢复计入房量"}，请核对平台真实订单状态'
            elif action == 'platform-check':
                current, kind, platform = data.get('date'), data.get('kind'), data.get('platform')
                if kind not in ROOMS or platform not in ('ctrip', 'meituan') or not today() <= current <= (date.today()+timedelta(days=366)).isoformat():
                    raise ValueError('关房提醒日期或平台不正确')
                found = next((a for a in inventory_alerts(s, today(), ROOMS) if a['date'] == current and a['kind'] == kind), None)
                if not found or found['fingerprint'] != data.get('fingerprint') or found['mode'] != data.get('mode') or found['platforms'].get(platform) is None:
                    raise ValueError('房量已经变化，请刷新提醒后再确认')
                s['platformChecks'][current + '|' + kind + '|' + platform] = dict(mode=found['mode'], fingerprint=found['fingerprint'], at=now())
                note = f'人工核对平台房量 · {current} · {kind} · {platform} · {found["mode"]}（未自动连接平台）'
            elif action == 'quick-arrive':
                b = next((b for b in s['bookings'] if b['id'] == data.get('bookingId')), None)
                if not b or b.get('deletedAt') or b['status'] != '预订' or not b['start'] <= today() < b['end']:
                    raise ValueError('只能为当日预订办理到店')
                b['status'] = '在住'
                note = f'确认到店 · {b["room"]}'
            elif action == 'quick-cancel':
                b = next((b for b in s['bookings'] if b['id'] == data.get('bookingId')), None)
                if not b or b.get('deletedAt') or b['status'] != '预订':
                    raise ValueError('该记录不是待入住预订')
                b['status'] = '已取消'
                note = f'取消预订 · {b["room"]} · 金额记录保留，退款需自行核对'
            elif action == 'quick-out':
                b = next((b for b in s['bookings'] if b['id'] == data.get('bookingId')), None)
                if not b or b.get('deletedAt') or b['status'] not in ['在住', '预订', '停用'] or not b['start'] <= today() < occupied_end(b):
                    raise ValueError('房间状态已经变化，请刷新查看')
                b['status'] = '已退房'
                b['releasedOn'] = today()
                b['end'] = max(today(), (day(b['start'])+timedelta(days=1)).isoformat())
                b['checkedOutAt'] = now()
                note = f'退房 · {b["room"]} · 已恢复空房'
            elif action == 'booking':
                raw = data['booking']
                old = next((b for b in s['bookings'] if b['id'] == raw.get('id')), None)
                if raw.get('id') and not old:
                    raise ValueError('找不到该订单')
                if old and (old.get('quick') or old.get('deletedAt')):
                    raise ValueError('请在简单版的“记录 / 修改”中编辑这条记录')
                b = {key: raw.get(key, '') for key in ['room', 'channel', 'status', 'guest', 'phone', 'reference', 'notes', 'start', 'end']}
                b.update(id=old['id'] if old else s['nextId'], total=money(raw['total']), rate=money(raw['rate']), created=old['created'] if old else now())
                validate_booking(b)
                clash = collision(s['bookings'], b)
                if clash:
                    raise ValueError(f"{b['room']} 与已有订单冲突：{clash['start']} 至 {clash['end']}。请换房或调整日期。")
                if old and (old['status'] == '停用') != (b['status'] == '停用') and b['status'] != '已取消':
                    raise ValueError('停用记录与客人订单不能互相转换，请新建记录')
                paid = sum(p['amount'] for p in s['payments'] if p['bookingId'] == b['id'])
                if b['total'] < paid:
                    raise ValueError('修改后的总金额小于已收款，请先登记退款')
                s['bookings'] = [b if x['id'] == b['id'] else x for x in s['bookings']] if old else s['bookings'] + [b]
                if not old:
                    s['nextId'] += 1
                note = f"{'修改' if old else '新增'}订单 #{b['id']} · {b['room']} · {b['start']}—{b['end']} · {b['status']}"
            elif action == 'payment':
                b = next((b for b in s['bookings'] if b['id'] == data.get('bookingId')), None)
                if not b or b.get('deletedAt') or b['status'] == '停用':
                    raise ValueError('未找到可收退款的订单')
                amount = money(data['amount'])
                if not amount:
                    raise ValueError('金额须大于零')
                method = data.get('method')
                if method not in ['微信', '支付宝', '现金', '银行卡', '平台结算', '其他']:
                    raise ValueError('收款方式不正确')
                paid = sum(p['amount'] for p in s['payments'] if p['bookingId'] == b['id'])
                if data.get('refund'):
                    if amount > paid:
                        raise ValueError('退款不能超过该订单净收款')
                    amount = -amount
                elif paid + amount > b['total'] or b['status'] == '已取消':
                    raise ValueError('收款不能超过订单总金额；已取消订单只能退款')
                s['payments'].append({'id': s['nextId'], 'bookingId': b['id'], 'amount': amount, 'method': method, 'note': bounded_text(data.get('note', ''), 300), 'at': now()})
                s['nextId'] += 1
                note = f"{'退款' if amount < 0 else '收款'} #{b['id']} · ¥{abs(amount) / 100:.2f} · {method}"
            elif action == 'settings':
                cfg = data['settings']
                result = {'reserve': {}, 'rates': {}}
                for kind in ROOMS:
                    reserve = cfg['reserve'][kind]
                    if type(reserve) is not int or not 0 <= reserve <= len(ROOMS[kind]):
                        raise ValueError('线下留房数量不正确')
                    result['reserve'][kind] = reserve
                    result['rates'][kind] = money(cfg['rates'][kind])
                s['settings'] = result
                note = '修改参考房价 / 默认线下留房'
            elif action in ['allocate', 'confirm']:
                d, kind = data['date'], data['kind']
                last = data.get('through', d)
                span = (day(last) - day(d)).days
                if not 0 <= span < 90:
                    raise ValueError('单次调房日期范围应为 1 到 90 天')
                if kind not in ROOMS or d < today():
                    raise ValueError('只能调整今天及以后的房量')
                for offset in range(span + 1):
                    current = (day(d) + timedelta(days=offset)).isoformat()
                    key = current + '|' + kind
                    if action == 'allocate':
                        if data.get('reset'):
                            s['overrides'].pop(key, None)
                        else:
                            a = {k: data[k] for k in ['ctrip', 'meituan', 'offline']}
                            if any(type(v) is not int or v < 0 for v in a.values()) or sum(a.values()) != available(s['bookings'], current, kind):
                                raise ValueError('携程 + 美团 + 线下留房必须等于每天的剩余房量')
                            s['overrides'][key] = a
                        note = f'调整分房 · {d} 至 {last} · {kind}'
                    else:
                        a = allocation(s['bookings'], s['settings'], s['overrides'], current, kind)
                        if data.get('ctrip') != a['ctrip'] or data.get('meituan') != a['meituan']:
                            raise ValueError('部分日期建议房量不同或已变化，请重新核对')
                        s['confirmed'][key] = dict(ctrip=a['ctrip'], meituan=a['meituan'], at=now())
                        note = f"人工核对两平台 · {d} 至 {last} · {kind} · 携程 {a['ctrip']} / 美团 {a['meituan']}"
            elif action == 'restore':
                restored = data['backup']
                self.validate_backup(restored)
                revision = s['revision']
                s = restored
                s['revision'] = revision
                s['confirmed'] = {}
                note = '从 JSON 备份恢复；恢复前数据已自动备份；请重新核对平台库存'
            else:
                raise ValueError('不支持的操作')
            s['revision'] += 1
            s['audit'].append({'at': now(), 'text': note})
            s['audit'] = s['audit'][-2000:]
            self.backup()
            with self.db:
                self.db.execute('UPDATE state SET payload=? WHERE id=1', (json.dumps(s, ensure_ascii=False),))
            return s

    @staticmethod
    def validate_backup(s):
        if not isinstance(s, dict) or s.get('schema') != 1:
            raise ValueError('不是本系统的备份文件')
        for k in ['bookings', 'payments', 'audit']:
            if not isinstance(s.get(k), list):
                raise ValueError('备份结构不完整')
        if len(s['bookings']) > 100000 or len(s['payments']) > 200000:
            raise ValueError('备份数据量过大')
        ids = set()
        by_id = {}
        previous = []
        for b in s['bookings']:
            # Historical statuses remain valid when restoring older snapshots.
            validate_booking(b)
            if type(b.get('id')) is not int or b['id'] < 1 or b['id'] in ids or collision(previous, b):
                raise ValueError('备份包含重复或冲突订单')
            ids.add(b['id'])
            by_id[b['id']] = b
            previous.append(b)
        validate_imported(s, ROOMS)
        balances = {}
        for p in s['payments']:
            if type(p.get('id')) is not int or p['id'] in ids or p['id'] < 1 or p.get('bookingId') not in by_id or type(p.get('amount')) is not int:
                raise ValueError('备份收款记录不正确')
            if p.get('method') not in ['微信', '支付宝', '现金', '银行卡', '平台结算', '其他'] or not isinstance(p.get('note'), str):
                raise ValueError('备份收款方式不正确')
            datetime.fromisoformat(p['at'])
            ids.add(p['id'])
            balances[p['bookingId']] = balances.get(p['bookingId'], 0) + p['amount']
        for bid, amount in balances.items():
            if not 0 <= amount <= by_id[bid]['total']:
                raise ValueError('备份收退款与订单金额不一致')
        if type(s.get('nextId')) is not int or s['nextId'] <= max(ids, default=0):
            raise ValueError('备份编号不正确')
        for k in ['settings', 'confirmed', 'overrides']:
            if not isinstance(s.get(k), dict):
                raise ValueError('备份设置不完整')
        for kind in ROOMS:
            for name, maximum in [('reserve', len(ROOMS[kind])), ('rates', 100000000)]:
                value = s['settings'][name][kind]
                if type(value) is not int or not 0 <= value <= maximum:
                    raise ValueError('备份房价或留房数不正确')
        for name in ['confirmed', 'overrides']:
            for key, obj in s[name].items():
                d, kind = key.split('|')
                day(d)
                if kind not in ROOMS:
                    raise ValueError('备份房型不正确')
                for field in (['ctrip', 'meituan', 'offline'] if name == 'overrides' else ['ctrip', 'meituan']):
                    if type(obj.get(field)) is not int or not 0 <= obj[field] <= len(ROOMS[kind]):
                        raise ValueError('备份分房数不正确')
        for row in s['audit']:
            if not isinstance(row.get('text'), str) or not isinstance(row.get('at'), str):
                raise ValueError('备份操作记录不正确')

def handler(store):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, code, body, mime='application/json; charset=utf-8', attachment=None):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'")
            if attachment:
                self.send_header('Content-Disposition', f'attachment; filename="{attachment}"')
            self.end_headers()
            self.wfile.write(body)

        def local(self):
            allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
            if self.headers.get('Host') not in allowed:
                self.send(403, {'error': '只允许本机访问'})
                return False
            origin = self.headers.get('Origin')
            if origin and origin not in {'http://' + x for x in allowed}:
                self.send(403, {'error': '来源不受信任'})
                return False
            return True

        def do_GET(self):
            if not self.local():
                return
            path = urlparse(self.path).path
            if path == '/api/state':
                self.send(200, served_state(store.read()))
            elif path == '/api/backup':
                self.send(200, store.read(), attachment='kasho-backup-' + today() + '.json')
            elif path == '/api/payments.csv':
                s = store.read()
                output = io.StringIO(newline='')
                w = csv.writer(output)
                w.writerow(['时间', '订单编号', '房号', '客人', '金额（元，负数为退款）', '方式', '备注'])
                def cell(v):
                    v = str(v)
                    return "'" + v if v[:1] in '=+-@\t\r' else v
                for p in s['payments']:
                    b = next(b for b in s['bookings'] if b['id'] == p['bookingId'])
                    w.writerow([p['at'], b['id'], b['room'], cell(b['guest']), f"{p['amount']/100:.2f}", p['method'], cell(p['note'])])
                self.send(200, output.getvalue().encode('utf-8-sig'), 'text/csv; charset=utf-8', 'kasho-payments-' + today() + '.csv')
            else:
                names = {'/': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css', '/simple.js': 'simple.js', '/money.js': 'money.js', '/monthly.js': 'monthly.js', '/ota.js': 'ota.js', '/simple.css': 'simple.css', '/batch.css': 'batch.css'}
                if path not in names:
                    self.send(404, {'error': '页面不存在'})
                    return
                name = names[path]
                mime = {'html': 'text/html; charset=utf-8', 'js': 'text/javascript; charset=utf-8', 'css': 'text/css; charset=utf-8'}[name.rsplit('.', 1)[1]]
                self.send(200, (ROOT / 'web' / name).read_bytes(), mime)

        def do_POST(self):
            if not self.local():
                return
            if self.headers.get('X-Kasho-Request') != 'frontdesk' or self.headers.get('Content-Type') != 'application/json':
                self.send(403, {'error': '请从前台系统内操作'})
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 20_000_000:
                    raise ValueError('请求大小不正确')
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError('请求格式不正确')
                action = urlparse(self.path).path.removeprefix('/api/')
                if action == 'ota-preview':
                    self.send(200, import_preview(store.read(), data.get('file')))
                    return
                state = store.write(action, data)
                self.send(200, served_state(state))
            except (ValueError, KeyError, TypeError, AttributeError) as e:
                self.send(400, {'error': str(e) if isinstance(e, ValueError) else '数据格式不正确，请检查输入或备份文件'})
            except Exception:
                self.send(500, {'error': '保存失败，数据未确认。请保留当前页面并检查本机磁盘空间。'})
    return Handler

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--data-dir', default=str(ROOT / 'data'))
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    store = Store(args.data_dir)
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), handler(store))
    except OSError:
        import urllib.request
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/api/state', timeout=2) as response:
                existing = json.load(response)
            if existing.get('app') == 'kasho-frontdesk':
                webbrowser.open(f'http://127.0.0.1:{args.port}')
                raise SystemExit(0)
        except (OSError, ValueError):
            pass
        print(f'Port {args.port} is in use. Try --port 8766.')
        raise SystemExit(1)
    print(f'KASHO Front Desk: http://127.0.0.1:{args.port}', flush=True)
    print('Keep this window running while using the front desk. Ctrl+C stops it.', flush=True)
    if args.open:
        threading.Timer(0.5, lambda: webbrowser.open(f'http://127.0.0.1:{args.port}')).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        store.db.close()
