import React, { useMemo, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { MENU, CATEGORIES, MenuItem } from '../lib/menu';
import {
  addToCart,
  removeFromCart,
  cartSubtotal,
  cartQuantity,
  CartLine,
} from '../lib/cart';
import { calcTotals, lookupPromo, Promo } from '../lib/pricing';
import { earnedPoints, rewardTier, pointsToNextReward } from '../lib/loyalty';

const STORE_STATE = 'CA';

export default function OrderScreen(): React.JSX.Element {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [promoCode, setPromoCode] = useState('');
  const [appliedPromo, setAppliedPromo] = useState<Promo | undefined>(undefined);

  const subtotal = useMemo(() => cartSubtotal(cart), [cart]);
  const totals = useMemo(
    () => calcTotals(subtotal, STORE_STATE, appliedPromo),
    [subtotal, appliedPromo]
  );
  const points = earnedPoints(totals.total);

  const onApplyPromo = () => {
    setAppliedPromo(lookupPromo(promoCode));
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.brand}>🌶  CHIPOTLE</Text>
        <Text style={styles.subhead}>Order Ahead</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {CATEGORIES.map((category) => (
          <View key={category} style={styles.section}>
            <Text style={styles.sectionTitle}>{category}</Text>
            {MENU.filter((m) => m.category === category).map((item: MenuItem) => (
              <TouchableOpacity
                key={item.id}
                style={styles.row}
                onPress={() => setCart((c) => addToCart(c, item.id))}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.itemPrice}>${item.price.toFixed(2)}</Text>
                </View>
                <View style={styles.addBtn}>
                  <Text style={styles.addBtnText}>ADD</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        ))}

        <View style={styles.bag}>
          <Text style={styles.sectionTitle}>Your Bag ({cartQuantity(cart)})</Text>
          {cart.length === 0 && <Text style={styles.muted}>Tap items above to add them.</Text>}
          {cart.map((line) => (
            <View key={line.item.id} style={styles.bagRow}>
              <Text style={styles.bagName}>
                {line.qty}× {line.item.name}
              </Text>
              <TouchableOpacity onPress={() => setCart((c) => removeFromCart(c, line.item.id))}>
                <Text style={styles.remove}>Remove</Text>
              </TouchableOpacity>
            </View>
          ))}

          <View style={styles.promoRow}>
            <TextInput
              style={styles.promoInput}
              placeholder="Promo code (e.g. GUAC20)"
              autoCapitalize="characters"
              value={promoCode}
              onChangeText={setPromoCode}
            />
            <TouchableOpacity style={styles.applyBtn} onPress={onApplyPromo}>
              <Text style={styles.applyBtnText}>Apply</Text>
            </TouchableOpacity>
          </View>

          <Totals label="Subtotal" value={totals.subtotal} />
          {totals.discount > 0 && <Totals label="Discount" value={-totals.discount} />}
          <Totals label="Tax" value={totals.tax} />
          <Totals label="Service fee" value={totals.serviceFee} />
          <Totals label="Total" value={totals.total} bold />

          <View style={styles.rewards}>
            <Text style={styles.rewardsText}>
              {rewardTier(points)} • +{points} pts
            </Text>
            <Text style={styles.muted}>{pointsToNextReward(points)} pts to a free entree</Text>
          </View>

          <TouchableOpacity style={styles.checkout} disabled={cart.length === 0}>
            <Text style={styles.checkoutText}>Place Order</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Totals({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <View style={styles.totalsRow}>
      <Text style={[styles.totalsLabel, bold && styles.bold]}>{label}</Text>
      <Text style={[styles.totalsValue, bold && styles.bold]}>${value.toFixed(2)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#ffffff' },
  header: { backgroundColor: '#1b1b1b', paddingVertical: 18, paddingHorizontal: 20 },
  brand: { color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: 2 },
  subhead: { color: '#A81612', fontSize: 14, fontWeight: '700', marginTop: 2 },
  body: { padding: 16, paddingBottom: 48 },
  section: { marginBottom: 18 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#A81612',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#efe7d8',
  },
  itemName: { fontSize: 16, fontWeight: '600', color: '#1b1b1b' },
  itemPrice: { fontSize: 13, color: '#6b6b6b', marginTop: 2 },
  addBtn: { backgroundColor: '#A81612', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6 },
  addBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  bag: { backgroundColor: '#f7f2ea', borderRadius: 12, padding: 16, marginTop: 8 },
  muted: { color: '#6b6b6b', fontSize: 13 },
  bagRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  bagName: { fontSize: 15, color: '#1b1b1b' },
  remove: { color: '#A81612', fontWeight: '700', fontSize: 13 },
  promoRow: { flexDirection: 'row', marginVertical: 14, gap: 8 },
  promoInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#dcd0b8',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  applyBtn: { backgroundColor: '#1b1b1b', paddingHorizontal: 18, justifyContent: 'center', borderRadius: 8 },
  applyBtnText: { color: '#fff', fontWeight: '800' },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  totalsLabel: { color: '#3a3a3a', fontSize: 15 },
  totalsValue: { color: '#3a3a3a', fontSize: 15 },
  bold: { fontWeight: '900', color: '#1b1b1b', fontSize: 17 },
  rewards: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#e4dccb' },
  rewardsText: { fontWeight: '800', color: '#4b6043' },
  checkout: { backgroundColor: '#A81612', borderRadius: 8, paddingVertical: 15, marginTop: 16, alignItems: 'center' },
  checkoutText: { color: '#fff', fontWeight: '900', fontSize: 16, letterSpacing: 1 },
});
