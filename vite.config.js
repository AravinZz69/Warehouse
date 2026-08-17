import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'frontend',
  publicDir: 'assets',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'frontend/index.html'),
        login: resolve(__dirname, 'frontend/pages/login.html'),
        signup: resolve(__dirname, 'frontend/pages/signup.html'),
        forgot_password: resolve(__dirname, 'frontend/pages/forgot-password.html'),
        dashboard: resolve(__dirname, 'frontend/pages/dashboard.html'),
        products: resolve(__dirname, 'frontend/pages/products.html'),
        product_stock: resolve(__dirname, 'frontend/pages/product-stock.html'),
        receipts: resolve(__dirname, 'frontend/pages/receipts.html'),
        deliveries: resolve(__dirname, 'frontend/pages/deliveries.html'),
        transfers: resolve(__dirname, 'frontend/pages/transfers.html'),
        moves: resolve(__dirname, 'frontend/pages/moves.html'),
        operation_form: resolve(__dirname, 'frontend/pages/operation-form.html'),
        transfer_form: resolve(__dirname, 'frontend/pages/transfer-form.html'),
        warehouse: resolve(__dirname, 'frontend/pages/warehouse.html'),
        adjustments: resolve(__dirname, 'frontend/pages/adjustments.html'),
        logs: resolve(__dirname, 'frontend/pages/logs.html'),
        users: resolve(__dirname, 'frontend/pages/users.html')
      }
    }
  },
  server: {
    port: 5173,
    open: '/index.html'
  }
});
