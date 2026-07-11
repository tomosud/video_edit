# ViralCut

https://tomosud.github.io/video_edit/

ブラウザだけで動く、シンプルな動画編集アプリ。
動画から欲しい部分を切り出して並べ、縦(9:16)・横(16:9)の MP4 を書き出せます。
動画はどこにもアップロードされず、すべて手元のブラウザ内で処理されます。

A simple video editor that runs entirely in your browser.
Cut out the parts you want, arrange them, and export vertical (9:16) and horizontal (16:9) MP4s.
Your videos never leave your computer.

<img width="1906" height="942" alt="image" src="https://github.com/user-attachments/assets/fec2bf93-2fd1-459a-8350-865cc6aac28e" />

https://github.com/user-attachments/assets/2f78c3a2-bd52-47a0-9cd5-3c45e27d1c89

## 使い方 / How to use

1. `Add Video` で動画を追加(ボタンへのドロップも可)
2. `1 Cut / Split` タイムラインの空白をダブルクリックしてカットを作成、ドラッグで範囲調整
3. `2 Cut Stock` のカードを `3 Edit` へドラッグして並べる
4. 字幕は `3 Edit` の字幕レーンをダブルクリックで追加、もう一度ダブルクリックで入力
5. プレビューをダブルクリックすると縦・横それぞれのクロップを調整できる
6. `ExportVideo` で MP4 を書き出し(縦・横・両方)

1. `Add Video` to add videos (drag & drop onto the button also works)
2. Double-click empty space on the `1 Cut / Split` timeline to make a cut, drag to adjust
3. Drag cards from `2 Cut Stock` into `3 Edit`
4. Double-click the caption lane in `3 Edit` to add a caption, double-click it again to type
5. Double-click a preview to adjust its vertical / horizontal crop
6. `ExportVideo` to export MP4 (vertical, horizontal, or both)

## 注意 / Notes

- 編集内容はブラウザ内に一時保存されます(最近の約15セッションまで)。ブラウザのサイトデータ削除などで消えるため、完成したら必ず書き出してください。
- 対応ブラウザ: Chrome / Edge。

- Edits are saved temporarily in your browser (about the latest 15 sessions). They can disappear when site data is cleared, so always export finished videos.
- Supported browsers: Chrome / Edge.

## Acknowledgements

Video metadata, frame access, and export are powered by [Mediabunny](https://github.com/Vanilagy/mediabunny).

## License

MIT. See LICENSE.
