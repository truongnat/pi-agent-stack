# Ghi chú Đánh giá UI: Thực tế Pi CLI TUI vs Thiết kế Google Stitch (DESIGN.md)

> Ngày ghi nhận: 26/09/2026
> Stitch Project ID: `projects/10946548453860688721`
> Phiên bản Pi Coding Agent: `0.87.1` (TUI Terminal Native)

---

## 1. Bản chất & Ranh giới Kỹ thuật (Technical Boundary)

Khi thiết kế giao diện trên **Google Stitch**, Stitch render dưới dạng **Full Canvas Web/GUI layout** (các panel chia cột đa luồng 3-column, hiệu ứng glow shadow, dynamic accordion click collapse, custom floating modals).

Tuy nhiên, **Pi Coding Agent** chạy trực tiếp trên **Terminal (TUI)** và phụ thuộc vào API Extension Hooks của Pi:
- `ctx.ui.setWidget(key, content, { placement: "aboveEditor" | "belowEditor" })` (Chỉ vẽ text theo dòng phẳng trên/dưới editor).
- `ctx.ui.setStatus(key, text)` (Chỉ vẽ 1 dòng text ngắn ở bottom footer).
- `ctx.ui.select(title, items)` (Sử dụng selector mặc định dạng menu dọc đơn giản của Pi, không tự do vẽ popup modal 2D).
- Terminal tiêu chuẩn không hỗ trợ click chuột tự do để thu gọn (Collapse/Expand) như Web DOM trừ khi viết custom Raw Terminal Render Loop.

---

## 2. Bảng so sánh chi tiết giữa Stitch Mockup vs Pi TUI thực tế

| Thành phần giao diện | Thiết kế trên Google Stitch | Thực tế trên Pi TUI hiện tại | Nguyên nhân & Hạn chế của Pi CLI |
|---|---|---|---|
| **Screen 1: Model Rail** | Header có border kép, hiển thị đa badge ngang chia cột rõ nét | Render 1 dòng ngang trên editor (`● ember │ model │ think │ jev`) | `aboveEditor` widget chỉ nhận mảng chuỗi `string[]`, không có flexbox hay 2-column layout. |
| **Screen 1: Thought Block (Accordion)** | Box có border 1px với nút `[▲ Collapse]`, tự co giãn dòng thinking | Pi tự render thinking stream mặc định (chỉ đổi được label text qua `setHiddenThinkingLabel`) | Pi CLI chưa cho phép extension hook can thiệp viết đè toàn bộ renderer của thinking stream. |
| **Screen 1: Tool Execution Cards** | Thẻ card nổi có màu nền `#1e2030` và biểu tượng `[ ■ bash: ... ]` | Pi in tool stream dạng dòng text console | Pi engine quản lý việc in kết quả tool, extension chỉ filter/trim được text trả về. |
| **Screen 2: Multi-Agent DAG (`/agents`)** | Sơ đồ cây tương tác nhiều nhánh (Interactive DAG Graph) | Vẽ bằng Unicode Box ASCII tĩnh (`┌─`, `│`, `└─`) | Terminal không có SVG/Canvas; chỉ render được sơ đồ dạng ký tự. |
| **Screen 3: Accounts Modal (`/accounts`)** | Popup modal trung tâm viền sáng Ember Copper `#f5a97f` | Danh sách dọc `ctx.ui.select` với icon `● active`/`○ switch` | `ctx.ui.select` là component prompt dựng sẵn của Pi, bị giới hạn kiểu hiển thị danh sách chọn đơn lẻ. |
| **Screen 4: Stitch Studio (`/stitch`)** | Giao diện 3 cột: Tokens Panel bên trái + Canvas giữa + Prompt Builder phải | Menu chọn hành động trong terminal + in Text Token Sheet | Terminal không hỗ trợ render hình ảnh canvas trực tiếp hay đa cột responsive phức tạp. |

---

## 3. Các hướng giải quyết để đạt được 100% độ hoàn mỹ như Stitch

Nếu muốn đạt được độ sắc nét, màu sắc glow, panel 3 cột và click-to-collapse như chính xác trong Stitch, có 2 con đường:

### Hướng A: Khai thác tối đa TUI Native của Pi (Tối ưu trong giới hạn Terminal)
- **Tạo Custom Entry Renderers**: Viết custom entry renderers (`pi.registerEntryRenderer`) sử dụng các ký tự box-drawing phức tạp hơn và bảng màu 24-bit TrueColor (`\x1b[38;2;R;G;Bm`).
- **Phân chia khối hiển thị**: Sử dụng `belowEditor` hoặc custom widget để tạo khung bảng phân tầng rõ hơn.

### Hướng B: Xây dựng Rust / Tauri Desktop Hybrid GUI (Khuyến nghị cho trải nghiệm đỉnh cao)
- Viết một Desktop App bằng **Rust + Tauri / egui / Slint** (như đã phân tích ở track so sánh trước).
- TUI bên dưới làm Core Engine (chạy backend Pi), còn giao diện bên trên là một Native Window độc lập:
  - Hiển thị 100% Canvas Stitch.
  - Multi-Agent DAG trực quan với hiệu ứng kéo thả / zoom.
  - Split-pane 3 cột: Editor / Token Swatches / Log Streams.
  - Hỗ trợ xem trực tiếp wireframe/ảnh do Stitch generate.

---

## 4. Tóm tắt hành động
1. Đã lưu tài liệu đối soát này vào repo để theo dõi.
2. Giữ nguyên bản TUI sạch và ổn định hiện tại cho CLI.
3. Khi bạn sẵn sàng, sẽ bắt đầu triển khai **Rust Hybrid Desktop App** để tái hiện nguyên vẹn 100% mockup Stitch!
