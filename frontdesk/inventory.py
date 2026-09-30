"""Future room-type inventory and human platform-adjustment reminders."""
import hashlib
import json
from datetime import date, timedelta


KINDS = ('标准间', '大床房', '高级观景', '舒适观景')
PLATFORMS = ('ctrip', 'meituan')
CANCELLED = {'已取消', '已关闭', '已撤销', '取消', '关闭'}


def active_order(order):
    return order['status'] not in CANCELLED and not order.get('manualIgnored', False)


def order_quantity(order):
    """A local cancellation survives reimport of an older platform export."""
    return min(order['quantity'], order.get('localQuantityCap', order['quantity'])) if active_order(order) else 0


def occupied_end(booking):
    return min(booking['end'], booking['releasedOn']) if booking.get('releasedOn') else booking['end']


def local_active(booking, current):
    return not booking.get('deletedAt') and booking['status'] != '已取消' and booking['start'] <= current < occupied_end(booking)


def snapshot(state, current, kind, rooms):
    local = [b for b in state['bookings'] if b['room'] in rooms[kind] and local_active(b, current)]
    local_rooms = {b['room'] for b in local}
    orders = [o for o in state.get('otaOrders', []) if o['kind'] == kind and active_order(o) and o['start'] <= current < o['end']]
    unassigned = 0
    contributors = [('local', b['id'], b['room'], b['start'], occupied_end(b), b['status'], b.get('otaOrderId', '')) for b in local]
    for order in orders:
        linked = sum(b.get('otaOrderId') == order['id'] for b in local)
        completed = sum(b.get('otaOrderId') == order['id'] and not b.get('deletedAt')
                        and b['status'] == '已退房' and occupied_end(b) <= current for b in state['bookings'])
        unassigned += max(0, order_quantity(order) - linked - completed)
        contributors.append(('ota', order['id'], order['site'], order['start'], order['end'], order_quantity(order), order['status']))
    physical = len(rooms[kind]) - len(local_rooms)
    free = physical - unassigned
    digest = hashlib.sha256(json.dumps(sorted(contributors, key=str), ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:16]
    return dict(date=current, kind=kind, capacity=len(rooms[kind]), local=len(local_rooms), unassigned=unassigned,
                physicalFree=physical, free=free, fingerprint=digest)


def _dates(state, today_value):
    first = date.fromisoformat(today_value)
    last = first + timedelta(days=90)
    for b in state['bookings']:
        if not b.get('deletedAt') and b['status'] != '已取消':
            last = max(last, date.fromisoformat(b['end']))
    for o in state.get('otaOrders', []):
        if active_order(o):
            last = max(last, date.fromisoformat(o['end']))
    for key in state.get('platformChecks', {}):
        try:
            last = max(last, date.fromisoformat(key.split('|', 1)[0]) + timedelta(days=1))
        except ValueError:
            pass
    last = min(last, first + timedelta(days=366))
    return [(first + timedelta(days=n)).isoformat() for n in range((last - first).days)]


def alerts(state, today_value, rooms):
    checks = state.get('platformChecks', {})
    result = []
    for current in _dates(state, today_value):
        for kind in KINDS:
            item = snapshot(state, current, kind, rooms)
            keybase = current + '|' + kind + '|'
            prior_close = any(checks.get(keybase + p, {}).get('mode') == 'close' for p in PLATFORMS)
            if item['free'] <= 0:
                item['mode'] = 'close'
            elif prior_close:
                item['mode'] = 'review-open'
            else:
                continue
            item['platforms'] = {}
            for platform in PLATFORMS:
                check = checks.get(keybase + platform, {})
                if item['mode'] == 'review-open' and check.get('mode') != 'close' and check.get('mode') != 'review-open':
                    item['platforms'][platform] = None
                elif item['mode'] == 'review-open' and check.get('mode') == 'review-open':
                    item['platforms'][platform] = check.get('fingerprint') == item['fingerprint']
                else:
                    item['platforms'][platform] = check.get('mode') == item['mode'] and check.get('fingerprint') == item['fingerprint']
            if item['mode'] == 'review-open' and all(value is not False for value in item['platforms'].values()):
                continue
            result.append(item)
    return result


def week_inventory(state, today_value, rooms):
    first = date.fromisoformat(today_value)
    return {(first + timedelta(days=n)).isoformat(): {kind: snapshot(state, (first + timedelta(days=n)).isoformat(), kind, rooms)
            for kind in KINDS} for n in range(7)}


def validate_imported(state, rooms):
    orders = state.get('otaOrders', [])
    checks = state.get('platformChecks', {})
    if not isinstance(orders, list) or len(orders) > 5000 or not isinstance(checks, dict) or len(checks) > 10000:
        raise ValueError('导入订单或关房记录格式不正确')
    seen = set()
    for o in orders:
        if not isinstance(o, dict) or not isinstance(o.get('id'), str) or not 4 <= len(o['id']) <= 100 or o['id'] in seen:
            raise ValueError('导入订单号重复或格式不正确')
        seen.add(o['id'])
        if o.get('kind') not in rooms or not isinstance(o.get('product'), str) or len(o['product']) > 120:
            raise ValueError('导入订单房型不正确')
        if not isinstance(o.get('status'), str) or not isinstance(o.get('site'), str) or len(o['status']) > 30 or len(o['site']) > 30:
            raise ValueError('导入订单状态不正确')
        if 'guest' in o and (not isinstance(o['guest'], str) or len(o['guest']) > 60):
            raise ValueError('导入订单姓名不正确')
        if 'manualIgnored' in o and type(o['manualIgnored']) is not bool:
            raise ValueError('导入订单人工核对状态不正确')
        if 'manual' in o and type(o['manual']) is not bool:
            raise ValueError('手工平台订单标记不正确')
        if type(o.get('quantity')) is not int or not 1 <= o['quantity'] <= 13:
            raise ValueError('导入订单间数不正确')
        if 'localQuantityCap' in o and (type(o['localQuantityCap']) is not int or not 0 <= o['localQuantityCap'] <= 13):
            raise ValueError('人工保留间数不正确')
        if not 1 <= (date.fromisoformat(o['end']) - date.fromisoformat(o['start'])).days <= 365:
            raise ValueError('导入订单日期不正确')
    for b in state['bookings']:
        if b.get('otaOrderId') and (not isinstance(b['otaOrderId'], str) or b['otaOrderId'] not in seen):
            raise ValueError('已有房号关联的携程订单不存在')
    for key, check in checks.items():
        parts = key.split('|')
        if len(parts) != 3 or parts[1] not in rooms or parts[2] not in PLATFORMS or not isinstance(check, dict):
            raise ValueError('关房核对记录不正确')
        date.fromisoformat(parts[0])
        if check.get('mode') not in ('close', 'review-open') or not isinstance(check.get('fingerprint'), str) or not isinstance(check.get('at'), str):
            raise ValueError('关房核对记录不正确')
