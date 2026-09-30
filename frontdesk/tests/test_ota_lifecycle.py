"""Synthetic orders only: full-stay assignment, cancellation and exact cent pricing."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inventory import order_quantity, snapshot
from server import DEFAULT_RATES, ROOMS, Store, day, today


class LifecycleTest(unittest.TestCase):
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

    def order(self, number=1, kind='标准间', quantity=1, start=1, nights=3, **extra):
        return dict(id=str(123456780000 + number), product=kind, site='携程', status='已接单',
                    start=self.date(start), end=self.date(start+nights), quantity=quantity,
                    guest='测试客人', **extra)

    def load(self, orders):
        with patch('server.parse_export', return_value=copy.deepcopy(orders)):
            return self.write('ota-import', file='synthetic', mapping={o['product']:o['product'] for o in orders})

    def free(self, s, offset=1):
        return sum(snapshot(s, self.date(offset), k, ROOMS)['free'] for k in ROOMS)

    def test_cancel_three_changes_five_to_eight_and_old_import_cannot_revive(self):
        orders = [self.order(1, quantity=4), self.order(2, '舒适观景', quantity=4)]
        s = self.load(orders)
        self.assertEqual(self.free(s), 5)
        ids = [b['id'] for b in s['bookings'][:3]]
        s = self.write('quick-batch', operation='edit', bookingIds=ids, changes={'status':'已取消'})
        self.assertEqual(self.free(s), 8)
        self.assertEqual(snapshot(s, self.date(1), '标准间', ROOMS)['unassigned'], 0)
        s = self.load(orders)
        self.assertEqual(self.free(s), 8)
        self.assertEqual(len(s['bookings']), 8)
        self.assertEqual(self.free(s, 3), 8)
        Store.validate_backup(s)

    def test_delete_restore_and_cancel_edit_restore_one_room(self):
        s = self.load([self.order(quantity=2)])
        bid = s['bookings'][0]['id']
        s = self.write('quick-delete', bookingId=bid)
        self.assertEqual(order_quantity(s['otaOrders'][0]), 1)
        s = self.write('quick-restore', bookingId=bid)
        self.assertEqual(order_quantity(s['otaOrders'][0]), 2)
        s = self.write('quick-cancel', bookingId=bid)
        self.assertEqual(self.free(s), 12)
        s = self.write('quick-edit', bookingId=bid, status='预订')
        self.assertEqual(self.free(s), 11)

    def test_pending_orders_can_be_partially_cancelled_without_a_room(self):
        self.write('quick-in', room='8302', channel='携程', amount='100', date=self.date(1), nights=3)
        order = self.order(quantity=3)
        s = self.load([order])
        self.assertEqual(snapshot(s, self.date(1), '标准间', ROOMS)['unassigned'], 3)
        s = self.write('ota-quantity', orderId=order['id'], quantity=1)
        self.assertEqual(snapshot(s, self.date(1), '标准间', ROOMS)['unassigned'], 1)
        self.assertEqual(self.free(s), 11)
        s = self.write('ota-quantity', orderId=order['id'], quantity=0)
        self.assertEqual(self.free(s), 12)
        self.assertEqual(self.free(self.load([order])), 12)

    def test_all_four_prices_exact_for_multiroom_multinight_and_departure_free(self):
        orders = [self.order(i+1, kind, min(2,len(rooms)), nights=4) for i,(kind,rooms) in enumerate(ROOMS.items())]
        s = self.load(orders)
        for b in s['bookings']:
            kind = next(k for k,rooms in ROOMS.items() if b['room'] in rooms)
            self.assertEqual((b['start'], b['end']), (self.date(1),self.date(5)))
            self.assertEqual(b['rate'], DEFAULT_RATES[kind])
            self.assertEqual(b['roomCharge'], DEFAULT_RATES[kind]*4)
            self.assertEqual((b['guestPaid'],b['paymentStatus']), (0,'未付'))
        for offset in range(1,5):
            self.assertEqual(self.free(s, offset), 6)
            self.assertTrue(all(snapshot(s,self.date(offset),k,ROOMS)['unassigned']==0 for k in ROOMS))
        self.assertEqual(self.free(s,5),13)
        self.assertEqual(self.load(orders)['bookings'], s['bookings'])

    def test_ongoing_order_is_assigned_for_full_interval_not_only_one_night(self):
        order = self.order(start=-1,nights=5)
        s = self.load([order])
        self.assertEqual(len(s['bookings']),1)
        self.assertEqual((s['bookings'][0]['start'],s['bookings'][0]['end']), (self.date(-1),self.date(4)))
        self.assertEqual(s['bookings'][0]['roomCharge'],19624*5)

    def test_short_linked_stay_repaired_and_manual_price_preserved(self):
        short = self.order(nights=1)
        s = self.load([short])
        bid = s['bookings'][0]['id']
        full = dict(short,end=self.date(5))
        s = self.load([full])
        self.assertEqual(s['bookings'][0]['end'],self.date(5))
        self.assertEqual(s['bookings'][0]['roomCharge'],19624*4)
        self.write('quick-edit',bookingId=bid, amount='680',paymentStatus='已付',notes='已人工确认金额')
        s = self.load([dict(full,end=self.date(6))])
        b = s['bookings'][0]
        self.assertEqual((b['roomCharge'],b['guestPaid'],b['notes']), (68000,68000,'已人工确认金额'))
        self.assertEqual(b['end'],self.date(6))

    def test_date_conflict_explained_not_overwritten_and_money_still_editable(self):
        order = self.order(nights=1)
        s = self.load([order])
        room, bid = s['bookings'][0]['room'], s['bookings'][0]['id']
        self.write('quick-in',room=room,channel='线下',amount='190',date=self.date(2))
        full = dict(order,end=self.date(4))
        s = self.load([full])
        self.assertIn('全部日期',s['otaOrders'][0]['assignmentIssue'])
        self.assertEqual(len(s['bookings']),2)
        self.assertEqual(s['bookings'][0]['end'],self.date(2))
        self.assertEqual(snapshot(s,self.date(2),'标准间',ROOMS)['unassigned'],1)
        s = self.write('quick-edit',bookingId=bid,amount='199',notes='已联系客人')
        self.assertEqual(s['bookings'][0]['roomCharge'],19900)
        self.write('quick-delete',bookingId=s['bookings'][1]['id'])
        s = self.write('ota-assign',orderId=order['id'])
        self.assertEqual(s['bookings'][0]['end'],full['end'])
        self.assertNotIn('assignmentIssue',s['otaOrders'][0])

    def test_import_cancelled_and_reduced_quantity_release_assigned_rooms(self):
        original = self.order(quantity=4)
        s = self.load([original])
        s = self.load([dict(original,quantity=2)])
        self.assertEqual(self.free(s),11)
        self.assertEqual(self.free(self.load([original])),11)
        s = self.load([dict(original,status='已取消')])
        self.assertEqual(self.free(s),13)
        self.assertEqual(self.free(self.load([original])),13)

    def test_cancel_one_then_import_platform_reduced_quantity_does_not_double_subtract(self):
        original = self.order(quantity=3)
        s = self.load([original])
        self.write('quick-cancel',bookingId=s['bookings'][0]['id'])
        s = self.load([dict(original,quantity=2)])
        self.assertEqual(self.free(s),11)
        self.assertEqual(order_quantity(s['otaOrders'][0]),2)

    def test_ignore_cancels_local_reservations_and_restore_reassigns(self):
        order = self.order(quantity=2)
        self.load([order])
        s = self.write('ota-ignore',orderId=order['id'],ignored=True)
        self.assertEqual(self.free(s),13)
        self.assertEqual(self.free(self.load([order])),13)
        s = self.write('ota-ignore',orderId=order['id'],ignored=False)
        self.assertEqual(self.free(s),11)

    def test_platform_cancel_does_not_erase_inhouse_stay(self):
        order = self.order(start=0)
        s = self.load([order])
        self.write('quick-arrive',bookingId=s['bookings'][0]['id'])
        s = self.load([dict(order,status='已取消')])
        self.assertEqual(s['bookings'][0]['status'],'在住')
        self.assertEqual(self.free(s,0),12)
        self.assertIn('已入住',s['otaOrders'][0]['assignmentIssue'])

    def test_early_checkout_does_not_create_phantom_unassigned_rooms(self):
        order = self.order(start=0)
        s = self.load([order])
        s = self.write('quick-out',bookingId=s['bookings'][0]['id'])
        self.assertEqual(self.free(s,0),13)
        self.assertEqual(self.free(s,1),13)
        self.assertEqual(len(self.load([order])['bookings']),1)

    def test_legacy_upgrade_repairs_cancelled_holds_and_zero_price_short_stay_once(self):
        order = self.order(quantity=3)
        s = self.load([order])
        legacy = copy.deepcopy(s)
        legacy.pop('otaRulesVersion')
        legacy['bookings'][0]['status']='已取消'
        legacy['bookings'][1].update(end=self.date(2),roomCharge=0,total=0,rate=0)
        legacy['bookings'][1].pop('autoPriced')
        legacy['bookings'][2].update(roomCharge=12300,total=12300,rate=4100,autoPriced=False)
        s = self.write('restore',backup=legacy)
        self.assertEqual(self.free(s),11)
        self.assertEqual(s['bookings'][1]['end'],order['end'])
        self.assertEqual(s['bookings'][1]['roomCharge'],19624*3)
        self.assertEqual(s['bookings'][2]['roomCharge'],12300)
        self.store.db.close()
        self.store=Store(self.tmp.name)
        self.assertEqual(self.store.read(),s)
        Store.validate_backup(s)

    def test_invalid_partial_cancellation_is_atomic(self):
        order = self.order()
        self.load([order])
        before = self.store.read()
        for value in [-1,2,True,1.5]:
            with self.assertRaises(ValueError):
                self.write('ota-quantity',orderId=order['id'],quantity=value)
            self.assertEqual(self.store.read(),before)

    def test_confirmed_payment_not_increased_by_later_date_extension(self):
        order = self.order(nights=1)
        s = self.load([order])
        self.write('quick-edit', bookingId=s['bookings'][0]['id'], paymentStatus='已付')
        s = self.load([dict(order, end=self.date(4))])
        self.assertEqual(s['bookings'][0]['end'], self.date(4))
        self.assertEqual(s['bookings'][0]['guestPaid'], 19624)
        self.assertEqual(s['bookings'][0]['roomCharge'], 19624)

    def test_move_repairs_entire_platform_interval_and_checks_last_night(self):
        order = self.order(nights=1)
        s = self.load([order])
        bid = s['bookings'][0]['id']
        self.write('quick-in',room='8302',channel='线下',amount='200',date=self.date(2))
        self.write('quick-in',room='8802',channel='线下',amount='200',date=self.date(3))
        full = dict(order,end=self.date(4))
        self.load([full])
        with self.assertRaises(ValueError):
            self.write('quick-move',bookingId=bid,room='8802')
        s = self.write('quick-move',bookingId=bid,room='8806')
        b = next(b for b in s['bookings'] if b['id']==bid)
        self.assertEqual((b['room'],b['end'],b['roomCharge']),('8806',full['end'],19624*3))
        self.assertNotIn('assignmentIssue',s['otaOrders'][0])

    def test_startup_upgrade_backs_up_original_and_does_not_repeat(self):
        s = self.load([self.order(quantity=2)])
        s.pop('otaRulesVersion')
        s['bookings'][0]['status']='已取消'
        with self.store.db:
            self.store.db.execute('UPDATE state SET payload=? WHERE id=1',(json.dumps(s,ensure_ascii=False),))
        count = len(list(self.store.backups.glob('*.sqlite3')))
        self.store.db.close()
        self.store=Store(self.tmp.name)
        upgraded=self.store.read()
        self.assertEqual(len(list(self.store.backups.glob('*.sqlite3'))),count+1)
        self.assertEqual(self.free(upgraded),12)
        self.assertEqual(upgraded['revision'],s['revision']+1)
        self.store.db.close()
        self.store=Store(self.tmp.name)
        self.assertEqual(self.store.read(),upgraded)


if __name__ == '__main__':
    unittest.main()
