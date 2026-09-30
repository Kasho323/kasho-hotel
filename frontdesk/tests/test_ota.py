import base64
import copy
import json
import os
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ctrip_xls import parse_export
from inventory import alerts, snapshot
from server import ROOMS, Store, day, today

SAMPLE = Path(os.environ['KASHO_CTRIP_SAMPLE']) if os.environ.get('KASHO_CTRIP_SAMPLE') else None
MAPPING = {
    '弥散式高级标准房<双早>': '标准间',
    '弥散式高级大床房<双早>': '大床房',
    '弥散式观景高级双床房<双早>': '高级观景',
    '弥散式观景舒适双床房<双早>': '舒适观景',
}


class OtaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(self.tmp.name)

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def write(self, action, **data):
        return self.store.write(action, dict(data, revision=self.store.read()['revision']))

    def date(self, offset):
        return (day(today()) + timedelta(days=offset)).isoformat()

    def test_full_reminder_and_manual_confirmation(self):
        for room in ROOMS['大床房']:
            self.write('quick-in', room=room, channel='线下', amount='200', date=self.date(1))
        s = self.store.read()
        target = next(a for a in alerts(s, today(), ROOMS) if a['date'] == self.date(1) and a['kind'] == '大床房')
        self.assertEqual(target['free'], 0)
        self.assertFalse(target['platforms']['ctrip'])
        self.assertFalse(target['platforms']['meituan'])
        self.write('platform-check', date=target['date'], kind=target['kind'], platform='ctrip', mode=target['mode'], fingerprint=target['fingerprint'])
        current = next(a for a in alerts(self.store.read(), today(), ROOMS) if a['date'] == self.date(1) and a['kind'] == '大床房')
        self.assertTrue(current['platforms']['ctrip'])
        self.assertFalse(current['platforms']['meituan'])
        self.write('platform-check', date=current['date'], kind=current['kind'], platform='meituan', mode=current['mode'], fingerprint=current['fingerprint'])
        self.assertTrue(all(next(a for a in alerts(self.store.read(), today(), ROOMS) if a['date'] == self.date(1) and a['kind'] == '大床房')['platforms'].values()))
        self.write('quick-edit', bookingId=1, nights=2)
        changed = next(a for a in alerts(self.store.read(), today(), ROOMS) if a['date'] == self.date(1) and a['kind'] == '大床房')
        self.assertFalse(changed['platforms']['ctrip'])
        self.assertFalse(changed['platforms']['meituan'])
        self.write('quick-delete', bookingId=2)
        reopened = next(a for a in alerts(self.store.read(), today(), ROOMS) if a['date'] == self.date(1) and a['kind'] == '大床房')
        self.assertEqual(reopened['mode'], 'review-open')
        self.assertEqual(reopened['free'], 1)

    def test_bad_file_and_mapping_atomic(self):
        with self.assertRaises(ValueError):
            parse_export(base64.b64encode(b'not a workbook').decode())
        before = self.store.read()
        with self.assertRaises(ValueError):
            self.write('ota-import', file=base64.b64encode(b'bad').decode(), mapping={})
        self.assertEqual(self.store.read(), before)

    def test_manual_meituan_future_order_and_assignment(self):
        start, end = self.date(20), self.date(21)
        s = self.write('ota-manual', orderId='MT-100', kind='高级观景', start=start, end=end, quantity=1, status='已接单')
        self.assertEqual(snapshot(s, start, '高级观景', ROOMS)['free'], 0)
        self.assertTrue(any(a['date'] == start and a['kind'] == '高级观景' for a in alerts(s, today(), ROOMS)))
        s = self.write('ota-manual', orderId='MT-100', kind='高级观景', start=start, end=end, quantity=1, status='已接单')
        self.assertEqual(len(s['otaOrders']), 1)
        s = self.write('quick-in', room='8801', channel='美团', amount='260', paymentStatus='未付', date=start, nights=1, otaOrderId='meituan:MT-100')
        self.assertEqual(snapshot(s, start, '高级观景', ROOMS)['free'], 0)
        self.assertEqual(s['bookings'][0]['channel'], '美团')
        Store.validate_backup(s)
        s = self.write('ota-manual', orderId='MT-100', kind='高级观景', start=start, end=end, quantity=1, status='已取消')
        self.assertEqual(s['bookings'][0]['status'], '已取消')
        self.assertEqual(snapshot(s, start, '高级观景', ROOMS)['free'], 1)

    def test_move_future_booking_preserves_details_and_checks_full_stay(self):
        start = self.date(1)
        s = self.write('quick-in', room='8302', channel='携程', amount='398', paymentStatus='未付',
                       date=start, nights=2, notes='张先生')
        booking_id = s['bookings'][0]['id']
        self.write('quick-in', room='8802', channel='线下', amount='190', date=self.date(2))
        with self.assertRaises(ValueError):
            self.write('quick-move', bookingId=booking_id, room='8802')
        s = self.write('quick-move', bookingId=booking_id, room='8806')
        moved = next(b for b in s['bookings'] if b['id'] == booking_id)
        self.assertEqual((moved['room'], moved['notes'], moved['roomCharge'], moved['paymentStatus']),
                         ('8806', '张先生', 39800, '未付'))
        self.assertEqual(snapshot(s, self.date(2), '标准间', ROOMS)['free'], 2)
        with self.assertRaises(ValueError):
            self.write('quick-move', bookingId=booking_id, room='8308')

    def test_import_assigns_name_once_and_skips_unlinked_manual_record(self):
        start, end = self.date(2), self.date(3)
        order = dict(id='123456789012', product='标准房', site='携程', status='已接单',
                     start=start, end=end, quantity=1, guest='王先生')
        with patch('server.parse_export', return_value=[order]):
            s = self.write('ota-import', file='test', mapping={'标准房': '标准间'})
            self.assertEqual(s['otaLastImportResult']['assigned'], 1)
            self.assertEqual(s['bookings'][0]['notes'], '王先生')
            self.assertEqual(s['bookings'][0]['otaOrderId'], order['id'])
            self.assertEqual(s['bookings'][0]['status'], '预订')
            self.assertEqual(s['bookings'][0]['roomCharge'], 19624)
            s = self.write('ota-import', file='test', mapping={'标准房': '标准间'})
            self.assertEqual(len(s['otaOrders']), 1)
            self.assertEqual(len(s['bookings']), 1)
            self.assertEqual(s['otaLastImportResult']['assigned'], 0)
        self.write('quick-in', room='8802', channel='携程', amount='200', date=self.date(4))
        other = dict(order, id='123456789013', start=self.date(4), end=self.date(5), guest='李先生')
        with patch('server.parse_export', return_value=[other]):
            s = self.write('ota-import', file='test', mapping={'标准房': '标准间'})
        self.assertEqual(s['otaLastImportResult']['assigned'], 0)
        self.assertEqual(s['otaLastImportResult']['skipped'], 1)
        self.assertEqual(len(s['bookings']), 2)

    def test_identical_duplicate_rows_collapse_but_conflicting_rows_reject(self):
        headers = ['订单号', '订单状态', '房型名称', '入住日期', '离店日期', '房间数', '预订网站', '客人姓名']
        row = ['123456789012', '已接单', '标准房', '2026年10月01日', '2026年10月02日', 1, '携程', '王先生']
        with patch('ctrip_xls.read_cells', return_value=[headers, row, row.copy()]):
            self.assertEqual(len(parse_export(base64.b64encode(b'test').decode())), 1)
        changed = row.copy()
        changed[5] = 2
        with patch('ctrip_xls.read_cells', return_value=[headers, row, changed]):
            with self.assertRaisesRegex(ValueError, '内容不同'):
                parse_export(base64.b64encode(b'test').decode())

    @unittest.skipUnless(SAMPLE is not None and SAMPLE.exists(), 'sample export is not available')
    def test_real_export_inventory_idempotency_and_link(self):
        encoded = base64.b64encode(SAMPLE.read_bytes()).decode()
        parsed = parse_export(encoded)
        self.assertEqual(len(parsed), 22)
        self.assertEqual({o['site'] for o in parsed}, {'携程', '去哪儿'})
        s = self.write('ota-import', file=encoded, mapping=MAPPING)
        self.assertEqual(len(s['otaOrders']), 22)
        self.assertTrue(all(isinstance(o.get('guest'), str) for o in s['otaOrders']))
        self.assertEqual(snapshot(s, '2026-10-01', '标准间', ROOMS)['free'], 0)
        self.assertEqual(snapshot(s, '2026-10-01', '大床房', ROOMS)['free'], 0)
        Store.validate_backup(s)
        before = [(o['id'],o['quantity']) for o in s['otaOrders']]
        booking_count = len(s['bookings'])
        s = self.write('ota-import', file=encoded, mapping=MAPPING)
        self.assertEqual([(o['id'],o['quantity']) for o in s['otaOrders']], before)
        self.assertEqual(len(s['bookings']), booking_count)
        order = next(o for o in s['otaOrders'] if o['kind'] == '标准间' and o['start'] == '2026-09-30')
        with self.assertRaises(ValueError):
            self.write('quick-in', room='8302', channel='线下', amount='200', date=order['start'])
        self.assertTrue(any(b.get('otaOrderId') == order['id'] for b in s['bookings']))
        self.assertEqual(snapshot(s, order['start'], '标准间', ROOMS)['free'], 0)
        other = next(o for o in s['otaOrders'] if o['kind'] == '标准间' and o['start'] == '2026-09-30' and o['id'] != order['id'])
        s = self.write('ota-ignore', orderId=other['id'], ignored=True)
        self.assertTrue(next(o for o in s['otaOrders'] if o['id'] == other['id'])['manualIgnored'])
        s = self.write('ota-import', file=encoded, mapping=MAPPING)
        self.assertTrue(next(o for o in s['otaOrders'] if o['id'] == other['id'])['manualIgnored'])
        s = self.write('ota-ignore', orderId=other['id'], ignored=False)
        self.assertEqual(snapshot(s, '2026-09-30', '标准间', ROOMS)['free'], 0)


if __name__ == '__main__':
    unittest.main()
