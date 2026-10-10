const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

test('storefront checkout confirms an order and Ops lists routes', async ({ page }) => {
  const screenshotDir = process.env.MISFITS_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const takeScreenshot = async (filename) => {
    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, filename), fullPage: true });
    }
  };

  await page.goto('/misfits');
  await expect(page.getByTestId('region-selector')).toHaveValue('nj-pa-ny');
  await expect(page.getByTestId('product-grid')).toBeVisible();
  await page.getByTestId('add-item-avocados').click();
  await expect(page.getByTestId('cart')).toContainText('Hass Avocados');
  await takeScreenshot('storefront.png');

  await page.getByTestId('checkout-button').click();
  await expect(page.getByTestId('delivery-window-picker')).toBeVisible();
  await expect(page.locator('input[name="delivery-window"]:checked')).toHaveCount(1);
  await takeScreenshot('delivery-windows.png');
  await page.getByTestId('place-order-button').click();
  await expect(page.getByTestId('order-confirmation')).toBeVisible();
  await expect(page.getByTestId('order-confirmation')).toContainText(/Order MM-[A-F0-9]{8}/);
  await takeScreenshot('confirmation.png');

  await page.goto('/misfits/ops');
  await expect(page.getByTestId('routes-table')).toContainText('NJ-01');
  await expect(page.getByTestId('routes-table').locator('tbody tr')).toHaveCount(8);
  await takeScreenshot('ops.png');
});
