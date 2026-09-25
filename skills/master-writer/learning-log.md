# Learning Log — nhật ký từng lần user sửa bản AI viết

Mỗi lần user sửa một đoạn AI vừa viết trong hội thoại, thêm 1 entry theo format dưới. Khi 1 quy tắc lặp lại ≥ 2 lần trong log này, chuyển lên `USER-VOICE.md`.

Format mỗi entry:

```
## YYYY-MM-DD — <tên ngắn quy tắc rút ra>
- Gốc: "<câu/đoạn AI viết>"
- Sửa: "<câu/đoạn user sửa thành>"
- Quy tắc: <tránh X, dùng Y — phải cụ thể, không mơ hồ>
- Mode lúc đó: <mode nào>
```

(chưa có entry nào)

## 2026-09-24 — MR description quá dài
- Gốc: MR !268 viết 5 đoạn văn xuôi giải thích nguyên nhân, cách sửa, tests, deploy (~450 từ).
- User: "gì mà cái mô tả nó chà bá lửa vậy, viết ngắn thôi".
- Quy tắc: MR/PR description của user → khuôn `## Summary` (3 bullet) + `## Test` (2-3 bullet) + 1 dòng deploy nếu cần, giống MR !263. Không viết đoạn giải thích nguyên nhân/lịch sử.
