# Anti-AI checklist — lớp lọc bắt buộc, mọi mode

Nguồn: tổng hợp lại từ phân tích pattern viết của LLM (shandley/claude-style-guide) + quan sát thêm cho tiếng Việt. Áp dụng lớp này TRƯỚC, mode chỉ tinh chỉnh phía trên.

## 1. Từ/cụm bị cấm (tiếng Anh)

| Tránh | Dùng thay |
|---|---|
| comprehensive | complete, full, thorough |
| utilize | use |
| leverage | use, apply |
| facilitate | help, enable |
| robust | strong, solid |
| nuanced | subtle, detailed |
| paradigm | model, approach |
| multifaceted | complex, varied |
| iterative | repeated, step-by-step |
| delve | explore, examine, look at |
| tapestry | mix, combination |
| myriad | many, numerous |
| plethora | many, lots of |
| fostering | building, encouraging |
| underscores | shows, highlights |
| realm | area, field |
| landscape | field, situation |
| crucial / pivotal | important, key, central |
| noteworthy | notable, worth mentioning |
| intricate | complex, detailed |

Không cần tránh tất cả liên từ nối — chỉ tránh loại bị lạm dụng: "Furthermore," "Moreover," "Additionally," ở đầu câu liên tiếp.

## 2. Từ/cụm bị cấm (tiếng Việt — tương đương "corporate AI Vietnamese")

- "không thể phủ nhận rằng", "trong thế giới ngày nay/hiện đại", "đóng vai trò quan trọng/then chốt", "góp phần không nhỏ", "như đã đề cập ở trên", "nói tóm lại/tóm lại có thể thấy", "hãy cùng [tìm hiểu/khám phá]", "không ngừng nỗ lực", "phát huy tối đa", "đẩy mạnh", "một cách toàn diện/hiệu quả" dùng như từ đệm không mang nghĩa.
- Liệt kê máy móc "Đầu tiên... Thứ hai... Cuối cùng..." khi không thực sự cần trình tự.
- Emoji làm bullet (🔹✅🚀) trong văn bản trang trọng hoặc bài viết dài.
- Bold giữa câu để nhấn từ khóa như slide ("Đây là điều **quan trọng nhất**") — nhấn bằng cách viết câu tốt hơn, không bằng markdown.

## 3. Cấu trúc câu & đoạn

- **Không xen kẽ câu rất ngắn – rất dài liên tục** (đặc trưng AI). Người viết thật xoay quanh độ dài trung bình, lệch có chủ đích, không đều tay.
- **Không nát đoạn thành nhiều đoạn 2-3 câu liên tiếp** kiểu bài blog SEO. Đoạn văn thật phát triển một ý đủ dài trước khi ngắt.
- **Không lạm dụng bullet list** khi nội dung là lập luận/tường thuật, không phải checklist thật. AI trung bình nhét ~9-10 bullet/bài; người viết thật gần như không dùng bullet trong prose.
- Cho phép câu cụt (fragment) có chủ đích, cho phép xưng "tôi/bạn" trực tiếp — đây là dấu hiệu người viết, không phải lỗi.
- Vào thẳng ý, không mở bài bằng câu tổng quát vô nghĩa ("Trong cuộc sống hiện đại, ai cũng...").
- Không đóng bài bằng câu tóm tắt lại toàn bộ ("Nói chung, qua những điều trên ta thấy...") — kết bằng một hình ảnh/khẳng định/lời kêu gọi cụ thể, không phải bản tóm tắt.

## 4. Self-check trước khi đưa bản viết cho user

1. Đếm bullet trong bài — nếu > 3 và nội dung không phải checklist/action-item thật, chuyển thành văn xuôi.
2. Grep nhanh trong đầu các từ ở mục 1 và 2 — có từ nào lọt vào không?
3. Đọc câu mở và câu kết — có nghe như slide/bài dịch không?
4. Có đoạn nào 2 câu liên tiếp đều dưới 8 từ, xen giữa 2 đoạn khác đều trên 25 từ không? Nếu có — sửa nhịp.
