import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages はリポジトリ名のサブパスで配信される(例: /seaglass/)。
// GitHub Actions では GITHUB_REPOSITORY = "ユーザー名/リポジトリ名" が入るので、
// そこからリポジトリ名を取り出して base に使う。ローカル開発では "/"。
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.GITHUB_ACTIONS && repo ? `/${repo}/` : "/";

export default defineConfig({
  base,
  plugins: [react()],
});
