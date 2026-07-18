import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages はリポジトリ名のサブパスで配信される(例: /seaglass/)。
// GitHub Actions では GITHUB_REPOSITORY = "ユーザー名/リポジトリ名" が入るので、
// そこからリポジトリ名を取り出して base に使う。ローカル開発では "/"。
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.GITHUB_ACTIONS && repo ? `/${repo}/` : "/";

export default defineConfig({
  base,
  plugins: [
    react(),
    // PWA 化。base(サブパス)は VitePWA が自動で引き継ぐので、
    // リポジトリ名が変わっても動く base 自動判定を壊さない。
    VitePWA({
      // 更新は静かに。次に開いたとき自動で最新へ切り替わる(通知やリロード煽りは出さない)。
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "シーグラスをさがして",
        short_name: "シーグラス",
        description:
          "実況天気と連動する、静かなビーチコーミングのゲーム。あなただけの海岸で、石や貝殻、シーグラスをさがしましょう。",
        lang: "ja",
        dir: "auto",
        start_url: ".",
        scope: ".",
        display: "standalone",
        orientation: "portrait",
        background_color: "#dce8e4",
        theme_color: "#cfe4e2",
        icons: [
          { src: "icons/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/pwa-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // ビルド成果物(アプリ本体)は事前キャッシュしてオフラインでも起動できるように。
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // オフライン時のナビゲーションは index.html へフォールバック(SPA)。
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            // 明朝体(Google Fonts の CSS)。一度読めればしばらくキャッシュ。
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" },
          },
          {
            // フォント本体(gstatic)。長めにキャッシュ。
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // 実況天気(Open-Meteo)。まずネットワーク、失敗時は直近のキャッシュを使う。
            // 取れないときはアプリ側で体験モードに切り替わる約束はそのまま保たれる。
            urlPattern: /^https:\/\/[^/]*open-meteo\.com\/.*/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "open-meteo",
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 3 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
