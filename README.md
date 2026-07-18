# シーグラスをさがして

実況天気と連動する、静かなビーチコーミングのゲーム。
地図には載っていない、あなただけの海岸で、石や貝殻、シーグラスをさがしましょう。

- 5つの海岸それぞれの「今日ほんとうの天気」を Open-Meteo から取得し、空・海・波・雨雪の演出に反映します（取得できない環境では体験モードに切り替わります）
- はじめて訪れる浜には、自分で名前をつけられます
- 石やシーグラスの形は一つずつ生成され、二度と同じ形にはなりません
- 拾ったものは「棚」に一点ずつ並び、いつ・どの浜で拾ったかが記録されます
- 漂着物はおよそ1時間に1個のペースで打ち上がり、浜を離れている間も溜まっていきます
- PWA に対応。ホーム画面に追加すると、アプリのように全画面で開けます（一度読み込めばオフラインでも起動します）

セーブデータはブラウザの `localStorage` に保存されます。

## ローカルで動かす

```bash
npm install
npm run dev
```

表示された `http://localhost:5173/` を開きます。

本番ビルドの確認:

```bash
npm run build
npm run preview
```

## GitHub Pages で公開する

このリポジトリには GitHub Actions のワークフロー（`.github/workflows/deploy.yml`）が含まれており、
`main` ブランチにプッシュすると自動でビルドして公開します。

1. GitHub で新しいリポジトリを作成する（例: `seaglass`）
2. このフォルダをプッシュする:

   ```bash
   git init
   git add .
   git commit -m "シーグラスをさがして"
   git branch -M main
   git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git
   git push -u origin main
   ```

3. GitHub のリポジトリ画面で **Settings → Pages** を開き、
   **Build and deployment → Source** を **GitHub Actions** に設定する
4. **Actions** タブでデプロイの完了を待つ
5. 完了すると `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開される

`base` はリポジトリ名から自動で決まるので、リポジトリ名を変えても設定を書き換える必要はありません。

## 独自ドメインやユーザーサイトで公開する場合

`https://<ユーザー名>.github.io/`（サブパスなし）で配信するリポジトリ名
（`<ユーザー名>.github.io`）を使う場合は、`vite.config.js` の `base` を `"/"` に固定してください。

## 使用ライブラリ

- React 18
- Vite 5
- 天気: [Open-Meteo](https://open-meteo.com/)（APIキー不要）
- フォント: Shippori Mincho（Google Fonts）
- PWA: [vite-plugin-pwa](https://vite-pwa-org.netlify.app/)（Service Worker とマニフェストの生成）
