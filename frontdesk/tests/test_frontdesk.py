import copy
from contextlib import closing
from unittest.mock import patch
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import timedelta
from pathlib import Path
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Store, ROOMS, allocation, available, day, today, handler, money


class FrontDeskTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(self.tmp.name)
        self.d = day(today())

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def date(self, delta):
        return (self.d + timedelta(days=delta)).isoformat()

    def write(self, action, **data):
        return self.store.write(action, dict(data, revision=self.store.read()['revision']))

    def booking(self, **changes):
        b = dict(room='8306', channel='携程', status='预订', guest='测试客人', phone='', reference='', notes='', start=self.date(1), end=self.date(2), rate='200.10', total='200.10')
        b.update(changes)
        return self.write('booking', booking=b)['bookings'][-1]

    def edit(self, b, **changes):
        raw = dict(b, rate=str(b['rate']/100), total=str(b['total']/100))
        raw.update(changes)
        return self.write('booking', booking=raw)

    def test_exact_room_inventory(self):
        self.assertEqual(sum(map(len, ROOMS.values())), 13)
        self.assertEqual(ROOMS['舒适观景'], ['8303', '8305', '8307', '8803', '8805', '8807'])

    def test_unpaid_charge_is_not_guest_payment(self):
        s = self.write('quick-in', room='8306', channel='线下', amount='600', nights=3, paymentStatus='未付')
        b = s['bookings'][0]
        self.assertEqual(b['guestPaid'], 0)
        self.assertEqual(b['roomCharge'], 60000)
        self.assertEqual(b['total'], 60000)
        self.assertEqual(b['paymentStatus'], '未付')
        self.assertEqual(available(s['bookings'], today(), '大床房'), 1)
        b = self.write('quick-edit', bookingId=b['id'], paymentStatus='已付')['bookings'][0]
        self.assertEqual(b['guestPaid'], 60000)
        self.assertEqual(b['roomCharge'], 60000)
        s = self.write('quick-edit', bookingId=b['id'], paymentStatus='未付', amount='500')
        self.assertEqual(s['bookings'][0]['guestPaid'], 0)
        self.assertEqual(s['bookings'][0]['roomCharge'], 50000)
        Store.validate_backup(s)

    def test_unpaid_kept_through_arrival_checkout_and_restore(self):
        self.write('quick-in', room='8306', channel='携程', amount='200', paymentStatus='未付')
        self.write('quick-in', room='8308', channel='美团', amount='300')
        self.write('quick-batch', operation='edit', bookingIds=[1,2], changes={'paymentStatus':'未付'})
        s = self.write('quick-out', bookingId=1)
        self.assertEqual(s['bookings'][0]['guestPaid'], 0)
        self.write('quick-delete', bookingId=1)
        s = self.write('quick-restore', bookingId=1)
        self.assertEqual(s['bookings'][0]['roomCharge'], 20000)
        Store.validate_backup(s)
        self.write('restore', backup=copy.deepcopy(s))
        self.store.db.close()
        self.store = Store(self.tmp.name)
        self.assertEqual(self.store.read()['bookings'][0]['paymentStatus'],'未付')

    def test_invalid_payment_status_is_atomic(self):
        for status in ['部分付', None, 0]:
            with self.assertRaises(ValueError):
                self.write('quick-in', room='8306', channel='线下', amount='100', paymentStatus=status)
        self.write('quick-in', room='8306', channel='线下', amount='100')
        before = self.store.read()
        with self.assertRaises(ValueError):
            self.write('quick-edit', bookingId=1, paymentStatus='wrong')
        self.assertEqual(before, self.store.read())
        bad=copy.deepcopy(before)
        bad['bookings'][0]['paymentStatus']='未付'
        with self.assertRaises(ValueError):
            Store.validate_backup(bad)

    def test_notes_create_edit_clear_and_money_unchanged(self):
        s = self.write('quick-in', room='8306', channel='携程', amount='288', notes='  晚到\n加一床被子  ')
        b = s['bookings'][0]
        self.assertEqual(b['notes'], '晚到\n加一床被子')
        s = self.write('quick-edit', bookingId=b['id'], notes='明早叫醒')
        for field in ['guestPaid', 'total', 'rate', 'start', 'end', 'room', 'status', 'channel']:
            self.assertEqual(s['bookings'][0][field], b[field])
        self.assertEqual(s['bookings'][0]['notes'], '明早叫醒')
        self.assertIn('更新备注', s['audit'][-1]['text'])
        s = self.write('quick-edit', bookingId=b['id'], notes='')
        self.assertEqual(s['bookings'][0]['notes'], '')

    def test_notes_survive_batch_checkout_delete_restore_and_backup(self):
        self.write('quick-in', room='8306', channel='携程', amount='288', notes='明早叫醒')
        self.write('quick-batch', operation='edit', bookingIds=[1], changes={'amount': '300', 'channel': '线下'})
        self.write('quick-out', bookingId=1)
        self.write('quick-delete', bookingId=1)
        s = self.write('quick-restore', bookingId=1)
        self.assertEqual(s['bookings'][0]['notes'], '明早叫醒')
        Store.validate_backup(s)
        self.write('restore', backup=copy.deepcopy(s))
        self.store.db.close()
        self.store = Store(self.tmp.name)
        self.assertEqual(self.store.read()['bookings'][0]['notes'], '明早叫醒')
        s = self.write('quick-in', room='8306', channel='线下', amount='200')
        self.assertEqual(s['bookings'][-1]['notes'], '')

    def test_notes_length_and_type_validation_are_atomic(self):
        for invalid in ['字'*1001, None, 42, ['备注']]:
            with self.assertRaises(ValueError):
                self.write('quick-in', room='8801', channel='美团', amount='200', notes=invalid)
            self.assertEqual(self.store.read()['revision'], 0)
        self.write('quick-in', room='8801', channel='美团', amount='200', notes='字'*1000)
        before = self.store.read()
        for invalid in ['字'*1001, None, 42]:
            with self.assertRaises(ValueError):
                self.write('quick-edit', bookingId=1, notes=invalid)
            self.assertEqual(self.store.read(), before)

    def quick_edit(self, b, **changes):
        data = dict(bookingId=b['id'], room=b['room'], channel=b['channel'],
                    date=b['start'], nights=(day(b['end'])-day(b['start'])).days,
                    amount=str(b.get('guestPaid', 0)/100), status=b['status'])
        data.update(changes)
        return self.write('quick-edit', **data)

    def test_edit_amount_channel_room_dates_and_persistence(self):
        b = self.write('quick-in', room='8306', channel='携程', amount='999')['bookings'][0]
        s = self.quick_edit(b, amount='288.01', channel='线下', room='8801', nights=3)
        changed = s['bookings'][0]
        self.assertEqual(changed['guestPaid'], 28801)
        self.assertEqual(changed['total'], 28801)
        self.assertEqual(changed['channel'], '线下')
        self.assertEqual(changed['end'], self.date(3))
        self.assertEqual(available(s['bookings'], today(), '大床房'), 2)
        self.assertEqual(available(s['bookings'], self.date(2), '高级观景'), 0)
        s = self.quick_edit(changed, date=self.date(2), status='预订', amount='0')
        Store.validate_backup(s)
        self.store.db.close()
        self.store = Store(self.tmp.name)
        self.assertEqual(self.store.read()['bookings'][0]['guestPaid'], 0)

    def test_edit_collision_and_invalid_amount_are_atomic(self):
        b = self.write('quick-in', room='8306', channel='携程', amount='300')['bookings'][0]
        self.write('quick-in', room='8308', channel='美团', amount='200', date=self.date(2))
        before = self.store.read()
        for changes in [dict(room='8308', nights=3), dict(amount='-1'), dict(amount='1.001'),
                        dict(nights=8), dict(date=self.date(1)), dict(channel='其他'), dict(room='0000')]:
            with self.assertRaises(ValueError):
                self.quick_edit(b, **changes)
            self.assertEqual(before, self.store.read())

    def test_edit_checked_out_record_and_undo_checkout(self):
        b = self.write('quick-in', room='8306', channel='携程', amount='300')['bookings'][0]
        b = self.write('quick-out', bookingId=b['id'])['bookings'][0]
        b = self.quick_edit(b, amount='180')['bookings'][0]
        self.assertEqual(b['releasedOn'], today())
        self.assertEqual(available([b], today(), '大床房'), 2)
        b = self.quick_edit(b, status='在住')['bookings'][0]
        self.assertNotIn('releasedOn', b)
        self.assertEqual(available([b], today(), '大床房'), 1)
        self.write('quick-out', bookingId=b['id'])
        self.write('quick-in', room='8306', channel='线下', amount='100')
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.quick_edit(b, status='在住')

    def test_delete_restore_and_backup_with_reused_room(self):
        b = self.write('quick-in', room='8801', channel='携程', amount='300')['bookings'][0]
        s = self.write('quick-delete', bookingId=b['id'])
        self.assertEqual(len(s['bookings']), 1)
        self.assertTrue(s['bookings'][0]['deletedAt'])
        self.assertEqual(available(s['bookings'], today(), '高级观景'), 1)
        for action in ['quick-out', 'quick-delete']:
            with self.assertRaises(ValueError):
                self.write(action, bookingId=b['id'])
        with self.assertRaises(ValueError):
            self.quick_edit(b)
        s = self.write('quick-restore', bookingId=b['id'])
        self.assertNotIn('deletedAt', s['bookings'][0])
        self.write('quick-delete', bookingId=b['id'])
        self.write('quick-in', room='8801', channel='线下', amount='200')
        before = self.store.read()
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.write('quick-restore', bookingId=b['id'])
        self.assertEqual(before, self.store.read())
        Store.validate_backup(before)
        self.write('restore', backup=copy.deepcopy(before))

    def test_historical_edit_and_cancelled_record_reopen(self):
        b = self.booking(start=self.date(-3), end=self.date(-1), status='已退房')
        s = self.quick_edit(b, amount='400')
        self.assertEqual(s['bookings'][0]['guestPaid'], 40000)
        b = self.write('quick-in', room='8801', channel='美团', amount='100', date=self.date(1))['bookings'][-1]
        b = self.write('quick-cancel', bookingId=b['id'])['bookings'][-1]
        s = self.quick_edit(b, status='预订', amount='200')
        self.assertEqual(available(s['bookings'], self.date(1), '高级观景'), 0)
        Store.validate_backup(s)

    def test_edit_does_not_rewrite_legacy_receipts(self):
        b = self.booking()
        s = self.write('payment', bookingId=b['id'], amount='150', method='微信')
        receipts = s['payments']
        s = self.quick_edit(b, amount='100')
        self.assertEqual(s['payments'], receipts)
        self.assertEqual(s['bookings'][0]['guestPaid'], 10000)
        Store.validate_backup(s)

    def test_simple_checkin_counts_room_and_records_guest_payment(self):
        s = self.write('quick-in', room='8306', channel='携程', amount='268.50')
        self.assertEqual(available(s['bookings'], today(), '大床房'), 1)
        self.assertEqual(s['bookings'][0]['guestPaid'], 26850)
        self.assertEqual(s['bookings'][0]['channel'], '携程')
        self.assertEqual(s['payments'], [])  # Guest OTA payment is not hotel cash received.

    def test_simple_checkout_releases_room_for_same_day_reuse(self):
        s = self.write('quick-in', room='8306', channel='美团', amount='200')
        s = self.write('quick-out', bookingId=s['bookings'][0]['id'])
        self.assertEqual(available(s['bookings'], today(), '大床房'), 2)
        self.assertEqual(s['bookings'][0]['guestPaid'], 20000)
        s = self.write('quick-in', room='8306', channel='线下', amount='180')
        self.assertEqual(available(s['bookings'], today(), '大床房'), 1)
        Store.validate_backup(s)
        restored = self.write('restore', backup=copy.deepcopy(s))
        self.assertEqual(available(restored['bookings'], today(), '大床房'), 1)

    def test_simple_duplicate_checkin_does_not_add_another_record(self):
        self.write('quick-in', room='8801', channel='携程', amount='300')
        before = self.store.read()
        with self.assertRaisesRegex(ValueError, '已经占用'):
            self.write('quick-in', room='8801', channel='美团', amount='300')
        self.assertEqual(before, self.store.read())

    def test_simple_stay_does_not_spill_into_next_day(self):
        s = self.write('quick-in', room='8306', channel='线下', amount='600')
        future = self.date(4)
        future_day = day(future)
        with patch('server.today', return_value=future), patch('server.date') as clock:
            clock.today.return_value = future_day
            self.assertEqual(available(s['bookings'], future, '大床房'), 2)
        self.assertEqual(s['bookings'][0]['guestPaid'], 60000)
        self.assertEqual(available(s['bookings'], today(), '大床房'), 1)

    def test_week_booking_covers_each_night_and_not_checkout_day(self):
        s = self.write('quick-in', room='8306', channel='携程', amount='600', date=self.date(1), nights=3)
        b = s['bookings'][0]
        self.assertEqual(b['status'], '预订')
        self.assertEqual(b['end'], self.date(4))
        for offset in [1, 2, 3]:
            self.assertEqual(available(s['bookings'], self.date(offset), '大床房'), 1)
        self.assertEqual(available(s['bookings'], self.date(4), '大床房'), 2)
        with self.assertRaisesRegex(ValueError, '已经占用'):
            self.write('quick-in', room='8306', channel='美团', amount='200', date=self.date(3), nights=2)

    def test_week_range_and_night_limits(self):
        for count in [0, 8, '3', True]:
            with self.assertRaises(ValueError):
                self.write('quick-in', room='8801', channel='线下', amount='100', nights=count)
        for offset in [-1, 7]:
            with self.assertRaises(ValueError):
                self.write('quick-in', room='8801', channel='线下', amount='100', date=self.date(offset))
        s = self.write('quick-in', room='8801', channel='线下', amount='700', date=self.date(6), nights=7)
        self.assertEqual(s['bookings'][0]['end'], self.date(13))

    def test_future_reservation_cannot_check_out_but_can_cancel(self):
        s = self.write('quick-in', room='8801', channel='美团', amount='200', date=self.date(1), nights=1)
        bid = s['bookings'][0]['id']
        with self.assertRaises(ValueError):
            self.write('quick-out', bookingId=bid)
        with self.assertRaises(ValueError):
            self.write('quick-arrive', bookingId=bid)
        s = self.write('quick-cancel', bookingId=bid)
        self.assertEqual(available(s['bookings'], self.date(1), '高级观景'), 1)
        self.assertEqual(s['bookings'][0]['guestPaid'], 20000)

    def test_multi_night_and_checkout_boundary(self):
        self.booking(start=self.date(1), end=self.date(5))
        self.assertEqual(available(self.store.read()['bookings'], self.date(4), '大床房'), 1)
        self.assertEqual(available(self.store.read()['bookings'], self.date(5), '大床房'), 2)
        self.booking(start=self.date(5), end=self.date(6))

    def test_double_booking_is_rejected_atomically(self):
        self.booking()
        before = self.store.read()
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.booking(channel='美团')
        self.assertEqual(before, self.store.read())

    def test_extension_checks_every_night(self):
        first = self.booking()
        self.booking(start=self.date(4), end=self.date(5))
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.edit(first, end=self.date(5), total='800.40')
        self.edit(first, end=self.date(4), total='600.30')

    def test_departure_day_is_free_without_manual_checkout(self):
        b = self.booking(status='在住', start=self.date(-2), end=self.date(0))
        self.assertEqual(available(self.store.read()['bookings'], today(), '大床房'), 2)
        self.booking(start=today(), end=self.date(1))
        self.edit(b, status='已退房')
        self.assertEqual(available(self.store.read()['bookings'], today(), '大床房'), 1)

    def test_september_14_stays_do_not_cover_15_unless_multi_night(self):
        from datetime import date as real_date
        with patch('server.today', return_value='2026-09-14'), patch('server.date') as clock:
            clock.today.return_value = real_date(2026, 9, 14)
            clock.fromisoformat.side_effect = real_date.fromisoformat
            self.write('quick-in', room='8306', channel='携程', amount='200', nights=1)
            self.write('quick-in', room='8308', channel='美团', amount='600', nights=3)
        with patch('server.today', return_value='2026-09-15'), patch('server.date') as clock:
            clock.today.return_value = real_date(2026, 9, 15)
            clock.fromisoformat.side_effect = real_date.fromisoformat
            before = self.store.read()
            self.assertEqual(available(before['bookings'], '2026-09-15', '大床房'), 1)
            self.write('quick-in', room='8306', channel='线下', amount='180')
            after = self.store.read()
            self.assertEqual(before['bookings'], after['bookings'][:2])
            Store.validate_backup(after)

    def test_batch_edit_only_selected_fields_and_single_commit(self):
        a = self.write('quick-in', room='8306', channel='携程', amount='600', nights=3)['bookings'][0]
        b = self.write('quick-in', room='8308', channel='美团', amount='200')['bookings'][-1]
        self.write('quick-in', room='8801', channel='美团', amount='333')
        before = self.store.read()
        backup_count = len(list(self.store.backups.glob('*.sqlite3')))
        s = self.write('quick-batch', operation='edit', bookingIds=[a['id'], b['id']], changes={'channel': '线下'})
        self.assertEqual(s['revision'], before['revision']+1)
        self.assertEqual(len(list(self.store.backups.glob('*.sqlite3'))), backup_count+1)
        self.assertEqual(s['bookings'][2], before['bookings'][2])
        for old, new in zip(before['bookings'][:2], s['bookings'][:2]):
            self.assertEqual(new['channel'], '线下')
            for field in ['guestPaid', 'rate', 'total', 'start', 'end', 'status', 'room']:
                self.assertEqual(new[field], old[field])
        s = self.write('quick-batch', operation='edit', bookingIds=[a['id'], b['id']], changes={'amount': '0', 'nights': 2})
        self.assertEqual([x['guestPaid'] for x in s['bookings'][:2]], [0, 0])
        self.assertEqual([x['end'] for x in s['bookings'][:2]], [self.date(2), self.date(2)])
        Store.validate_backup(s)

    def test_batch_delete_restore_and_missing_ids_are_atomic(self):
        self.write('quick-in', room='8306', channel='携程', amount='100')
        self.write('quick-in', room='8308', channel='美团', amount='200')
        s = self.write('quick-batch', operation='delete', bookingIds=[1, 2])
        self.assertTrue(all(b.get('deletedAt') for b in s['bookings']))
        self.assertEqual(available(s['bookings'], today(), '大床房'), 2)
        s = self.write('quick-batch', operation='restore', bookingIds=[1, 2])
        self.assertEqual(available(s['bookings'], today(), '大床房'), 0)
        for ids in [[], [1, 1], [1, 99], [True], ['1'], list(range(1, 202))]:
            with self.assertRaises(ValueError):
                self.write('quick-batch', operation='delete', bookingIds=ids)
            self.assertEqual(s, self.store.read())

    def test_batch_edit_final_state_conflicts_and_rollback(self):
        self.write('quick-in', room='8306', channel='携程', amount='100')
        self.write('quick-in', room='8306', channel='美团', amount='200', date=self.date(1))
        # Both bookings can shift together; check the final state, not intermediate states.
        self.write('quick-batch', operation='edit', bookingIds=[1, 2], changes={'channel': '线下'})
        before = self.store.read()
        for changes in [{'date': today()}, {'nights': 3}, {'amount': '-1'}, {}, {'room': '8801'}, {'status': 'wrong'}]:
            with self.assertRaises(ValueError):
                self.write('quick-batch', operation='edit', bookingIds=[1, 2], changes=changes)
            self.assertEqual(before, self.store.read())
        self.write('quick-batch', operation='delete', bookingIds=[1, 2])
        self.write('quick-in', room='8306', channel='线下', amount='100', date=self.date(1))
        before = self.store.read()
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.write('quick-batch', operation='restore', bookingIds=[1, 2])
        self.assertEqual(before, self.store.read())
        Store.validate_backup(before)

    def test_batch_edit_invalid_second_record_rolls_back_first(self):
        self.write('quick-in', room='8306', channel='携程', amount='100')
        self.write('quick-in', room='8308', channel='美团', amount='200', date=self.date(1))
        before = self.store.read()
        with self.assertRaises(ValueError):
            self.write('quick-batch', operation='edit', bookingIds=[1, 2], changes={'amount': '50', 'status': '在住'})
        self.assertEqual(before, self.store.read())

    def test_cancel_releases_inventory(self):
        b = self.booking()
        self.edit(b, status='已取消')
        self.assertEqual(available(self.store.read()['bookings'], self.date(1), '大床房'), 2)

    def test_same_day_checkout_and_future_checkout_guard(self):
        b = self.booking(status='在住', start=today(), end=self.date(1))
        self.edit(b, status='已退房')
        self.assertEqual(available(self.store.read()['bookings'], today(), '大床房'), 1)
        with self.assertRaisesRegex(ValueError, '未来'):
            self.booking(room='8308', status='已退房', start=self.date(2), end=self.date(3))

    def test_maintenance_occupies_inventory(self):
        self.booking(room='8801', status='停用', total='0', rate='0')
        self.assertEqual(available(self.store.read()['bookings'], self.date(1), '高级观景'), 0)

    def test_channel_split_never_duplicates_available_stock(self):
        b = self.booking()
        s = self.store.read()
        a = allocation(s['bookings'], s['settings'], s['overrides'], self.date(1), '大床房')
        self.assertEqual(a, dict(free=1, ctrip=1, meituan=0, offline=0))
        self.booking(room='8308')
        s = self.store.read()
        a = allocation(s['bookings'], s['settings'], s['overrides'], self.date(1), '大床房')
        self.assertEqual(a['ctrip'] + a['meituan'], 0)

    def test_confirmation_becomes_stale_after_booking(self):
        d, kind = self.date(1), '大床房'
        self.write('confirm', date=d, kind=kind, ctrip=1, meituan=1)
        self.booking()
        s = self.store.read()
        a = allocation(s['bookings'], s['settings'], s['overrides'], d, kind)
        self.assertNotEqual(s['confirmed'][d+'|'+kind]['meituan'], a['meituan'])

    def test_allocations_validate_and_shrink_after_sale(self):
        d, kind = self.date(1), '标准间'
        with self.assertRaisesRegex(ValueError, '必须等于'):
            self.write('allocate', date=d, kind=kind, ctrip=4, meituan=4, offline=0)
        self.write('allocate', date=d, kind=kind, ctrip=1, meituan=2, offline=1)
        for room in ['8302', '8802', '8806']:
            self.booking(room=room)
        s = self.store.read()
        self.assertEqual(allocation(s['bookings'], s['settings'], s['overrides'], d, kind), dict(free=1, ctrip=0, meituan=0, offline=1))

    def test_money_is_exact_and_invalid_values_rejected(self):
        self.assertEqual(money('200.10'), 20010)
        for value in ['-1', 'NaN', 'Infinity', '1.001', '1000001', 'abc']:
            with self.assertRaises(ValueError):
                money(value)

    def test_batch_confirmation_is_atomic_across_dates(self):
        self.write('confirm', date=self.date(1), through=self.date(4), kind='大床房', ctrip=1, meituan=1)
        self.assertEqual(len(self.store.read()['confirmed']), 4)
        self.booking(start=self.date(3), end=self.date(4))
        before = self.store.read()
        with self.assertRaisesRegex(ValueError, '房量不同'):
            self.write('confirm', date=self.date(1), through=self.date(4), kind='大床房', ctrip=1, meituan=1)
        self.assertEqual(before, self.store.read())

    def test_restore_requires_rechecking_platform_stock(self):
        self.write('confirm', date=self.date(1), kind='大床房', ctrip=1, meituan=1)
        backup = self.store.read()
        self.write('restore', backup=backup)
        self.assertEqual(self.store.read()['confirmed'], {})

    def test_payments_refunds_and_lower_total(self):
        b = self.booking()
        self.write('payment', bookingId=b['id'], amount='150.10', method='微信', note='到账')
        with self.assertRaisesRegex(ValueError, '超过'):
            self.write('payment', bookingId=b['id'], amount='60', method='现金')
        with self.assertRaisesRegex(ValueError, '先登记退款'):
            self.edit(b, total='100')
        self.write('payment', bookingId=b['id'], amount='50.10', method='微信', refund=True)
        self.edit(b, total='100')
        self.assertEqual(sum(p['amount'] for p in self.store.read()['payments']), 10000)
        with self.assertRaisesRegex(ValueError, '退款不能超过'):
            self.write('payment', bookingId=b['id'], amount='100.01', method='微信', refund=True)

    def test_stale_window_cannot_overwrite(self):
        self.booking()
        with self.assertRaisesRegex(ValueError, '另一窗口'):
            self.store.write('settings', {'revision': 0})

    def test_persistence_and_prewrite_backup(self):
        self.booking()
        snapshots = list(self.store.backups.glob('*.sqlite3'))
        self.assertEqual(len(snapshots), 1)
        with closing(sqlite3.connect(snapshots[0])) as db:
            self.assertEqual(json.loads(db.execute('SELECT payload FROM state').fetchone()[0])['bookings'], [])
        self.store.db.close()
        self.store = Store(self.tmp.name)
        self.assertEqual(len(self.store.read()['bookings']), 1)

    def test_backup_roundtrip_and_conflict_rejection(self):
        self.booking()
        original = self.store.read()
        self.booking(room='8308')
        self.write('restore', backup=copy.deepcopy(original))
        self.assertEqual(len(self.store.read()['bookings']), 1)
        bad = copy.deepcopy(original)
        duplicate = dict(bad['bookings'][0], id=123)
        bad['bookings'].append(duplicate)
        bad['nextId'] = 124
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.write('restore', backup=bad)

    def test_http_serves_and_blocks_cross_origin_mutation(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler(self.store))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            with urllib.request.urlopen(base+'/api/state') as response:
                self.assertEqual(json.load(response)['app'], 'kasho-frontdesk')
            with urllib.request.urlopen(base+'/') as response:
                self.assertIn('卡秀'.encode(), response.read())
            req = urllib.request.Request(base+'/api/booking', data=b'{}', headers={'Content-Type':'application/json', 'X-Kasho-Request':'frontdesk', 'Origin':'https://untrusted.example'})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req)
            self.assertEqual(ctx.exception.code, 403)
            ctx.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main(verbosity=2)
