import React from 'react';
import { StatusBar } from 'expo-status-bar';
import OrderScreen from './src/screens/OrderScreen';

export default function App(): React.JSX.Element {
  return (
    <>
      <StatusBar style="light" />
      <OrderScreen />
    </>
  );
}
