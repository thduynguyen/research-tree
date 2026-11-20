import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' lets the built site run from any path (GitHub Pages, Cloudflare Pages).
export default defineConfig({ base: './', plugins: [react()] });
