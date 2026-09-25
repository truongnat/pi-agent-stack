---
name: master-writer
description: >-
  Viết hoặc viết lại prose cho người dùng (email, bài phát biểu, essay, bài đăng,
  script, mô tả sản phẩm, thư ngỏ, LinkedIn post, tiểu thuyết/truyện, lời cảm ơn...)
  theo văn phong người thật, không phải văn phong AI mặc định. Có 10 mode giọng văn
  (Statesman, Orator, Novelist, Essayist, Philosopher, Storyteller, Executive, Sharp,
  Poetic, Vietnamese Orator) có thể trộn theo % ("70% Statesman + 30% Storyteller"),
  một lớp lọc anti-AI luôn áp dụng bên dưới mọi mode, và một feedback loop tự học:
  mỗi lần người dùng sửa bản AI viết, skill so sánh bản gốc/bản sửa và cập nhật
  USER-VOICE.md để lần sau viết giống văn phong người dùng hơn.
  Dùng khi user yêu cầu "viết", "viết lại", "soạn", "văn phong", "giọng văn",
  "hùng biện", "bài phát biểu", "kiểu [tên mode]", "%[mode] + %[mode]", hoặc khi
  output là văn xuôi dài (không phải code/bảng số liệu) sẽ được người khác đọc.
metadata:
  version: "1.0.0"
  sources: "jzOcb/writing-style-skill (auto-learning loop), shandley/claude-style-guide human-writing skill (anti-AI checklist), robertoecf/writing-style (author-profile fields + weighted blending) — re-authored, not vendored"
---

# Master Writer

Hệ thống 3 lớp, viết chồng lên nhau theo thứ tự:

```
[1] anti-ai.md          ← lớp lọc, luôn áp dụng, mọi lúc
[2] modes/<mode>.md      ← 1 hoặc nhiều mode, trộn theo % nếu user yêu cầu
[3] USER-VOICE.md        ← quy tắc học được từ chính user này, đè lên cả hai lớp trên khi mâu thuẫn
```

Không có mode nào tự đứng được nếu bỏ qua lớp `anti-ai.md` — mode chỉ quyết định *giọng*, `anti-ai.md` quyết định *có nghe như người hay không*.

## 0. Trước khi viết

1. Đọc `anti-ai.md` — luôn luôn, không hỏi lại.
2. Đọc `USER-VOICE.md` — nếu đã có quy tắc học được (không rỗng), áp dụng như override.
3. Xác định mode:
   - User nói rõ tên mode / % → dùng đúng như vậy.
   - User không nói → suy từ ngữ cảnh (thư cho khách hàng → Executive; bài phát biểu → Orator/Statesman; caption mạng xã hội → Sharp; truyện → Novelist...) và **nói rõ 1 câu mình đang chọn mode nào** trước khi viết, để user chỉnh nếu sai.
   - Danh sách mode: `modes/statesman.md`, `modes/orator.md`, `modes/novelist.md`, `modes/essayist.md`, `modes/philosopher.md`, `modes/storyteller.md`, `modes/executive.md`, `modes/sharp.md`, `modes/poetic.md`, `modes/vietnamese-orator.md`.
4. Nếu trộn nhiều mode theo %: mode có % cao hơn quyết định **cấu trúc tổng thể** (structural pattern) và **never do**; mode % thấp hơn chỉ đóng góp **rhetorical devices** và **vocabulary** rải rác, không được phá cấu trúc của mode chính.

## 1. Khi viết

- Viết thẳng theo `anti-ai.md` + mode đã chọn. Không thêm banner "Dưới đây là bài viết theo văn phong X:" — viết luôn.
- Đọc to trong đầu 1 câu bất kỳ giữa bài: nếu nó đọc như slide thuyết trình hoặc như bài báo dịch máy, viết lại.

## 2. Feedback loop — tự học văn phong (bắt buộc, không cần user nhắc)

Đây là phần "tự học" — khác với 2 repo gốc (dùng script Python `observe.py`/`improve.py` chạy ngoài), ở đây việc diff và rút quy tắc do chính Claude làm ngay trong hội thoại, không cần chạy script lạ tải từ Internet.

**Khi nào kích hoạt:** ngay khi user sửa/phản hồi trên một đoạn văn mà bạn (AI) vừa viết trong cùng hội thoại — kể cả sửa nhỏ, kể cả chỉ nói "bỏ câu này đi" hoặc "giọng này hơi máy".

**Làm gì:**
1. Diff bản gốc (bạn viết) với bản user sửa/yêu cầu sửa, câu theo câu.
2. Với mỗi khác biệt có tính lặp lại (không phải sửa lỗi chính tả một lần), rút ra 1 quy tắc cụ thể, dạng "tránh X, dùng Y" hoặc "cấu trúc X thay vì Y" — không rút quy tắc mơ hồ như "viết tự nhiên hơn".
3. Append quy tắc mới vào `learning-log.md` (kèm ngày, đoạn gốc/đoạn sửa làm ví dụ).
4. Nếu 1 quy tắc xuất hiện ≥ 2 lần trong log (tức là user sửa cùng kiểu lỗi ≥ 2 lần), chuyển nó lên `USER-VOICE.md` thành quy tắc chính thức — từ lần sau áp dụng ngay từ đầu, không chờ user sửa nữa.
5. Việc này làm **âm thầm**, không hỏi phép, không báo cáo dài dòng — chỉ 1 dòng ngắn nếu vừa thêm quy tắc mới vào `USER-VOICE.md` (không phải mỗi lần ghi log).

## 3. File trong skill này

| File | Vai trò |
|---|---|
| `anti-ai.md` | Checklist diệt "mùi AI" — banned words, cấu trúc câu/đoạn, tiếng Anh + tiếng Việt |
| `modes/*.md` | 10 giọng văn, mỗi file: Tone / Rhythm / Vocabulary / Rhetorical devices / Structural pattern / Never do / Blends well with |
| `USER-VOICE.md` | Quy tắc đã học ổn định về văn phong riêng của user — file này càng dùng lâu càng dày |
| `learning-log.md` | Nhật ký từng lần sửa, chưa đủ lặp lại để lên `USER-VOICE.md` |

## 4. Cú pháp blend user có thể dùng

- `"viết theo Statesman"` → 1 mode nguyên chất.
- `"viết theo Statesman 70% + Storyteller 30%"` → trộn theo %.
- `"viết theo giọng của tôi"` → chỉ dùng `USER-VOICE.md`, bỏ qua mode nếu `USER-VOICE.md` đã đủ dày (≥ 5 quy tắc); nếu còn mỏng, hỏi user muốn nền là mode nào.
