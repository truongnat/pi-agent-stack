import type { PreferenceCategory } from "./types.ts";

export interface ExtractedPreferenceSignal {
  category: PreferenceCategory;
  key: string;
  rule: string;
  isCorrection: boolean;
  confidence: number;
}

/**
 * Heuristic System 1 pattern matcher to detect user corrections and preference signals.
 */
export function extractPreferencesFromPrompt(
  prompt: string,
): ExtractedPreferenceSignal[] {
  const signals: ExtractedPreferenceSignal[] = [];
  const lower = prompt.toLowerCase();

  // 1. Strict Typing / No any
  if (
    /(đừng dùng any|không dùng any|no any|never use any|strict type|type safety|tránh any|no-any)/i.test(
      prompt,
    )
  ) {
    signals.push({
      category: "coding",
      key: "strict_typing_no_any",
      rule: "Ensure strict type safety in TypeScript: use explicit interfaces/types, TypeBox schemas, and never use any.",
      isCorrection: true,
      confidence: 0.95,
    });
  }

  // 2. Early Return / Guard Clauses
  if (
    /(early return|guard clause|return sớm|tránh lồng if|flatten if)/i.test(
      prompt,
    )
  ) {
    signals.push({
      category: "coding",
      key: "guard_clauses_early_return",
      rule: "Prefer early-return guard clauses to minimize indentation and avoid deeply nested if-else blocks.",
      isCorrection: true,
      confidence: 0.9,
    });
  }

  // 3. Concise Communication / No Fluff
  if (
    /(ngắn gọn|đừng dài dòng|bỏ chào hỏi|no fluff|concise|đi thẳng vào vấn đề|tóm tắt ngắn)/i.test(
      prompt,
    )
  ) {
    signals.push({
      category: "communication",
      key: "direct_no_fluff",
      rule: "Provide concise, direct answers with clear bullet points and actionable code diffs without conversational fluff.",
      isCorrection: true,
      confidence: 0.95,
    });
  }

  // 4. TDD / Test Verification First
  if (
    /(tdd|viết test trước|test first|chạy test|viết unit test|verify failing test)/i.test(
      prompt,
    )
  ) {
    signals.push({
      category: "workflow",
      key: "tdd_and_verification",
      rule: "Verify changes by running the automated test suite (e.g. npm test) before finishing.",
      isCorrection: false,
      confidence: 0.9,
    });
  }

  // 5. Minimal Diff / Preserve Style
  if (
    /(minimal diff|đừng sửa linh tinh|giữ nguyên comment|không format lại|preserve comment)/i.test(
      prompt,
    )
  ) {
    signals.push({
      category: "coding",
      key: "minimal_diff_preservation",
      rule: "Preserve existing style, indentation, docstrings, and unrelated code; make minimal focused edits.",
      isCorrection: true,
      confidence: 0.9,
    });
  }

  // 6. Direct Root-Cause / Check Log First
  if (
    /(root cause|xem log|check log|lấy stack trace|kiểm tra log|đừng đoán mò|bắt exception|investigate error|error trace)/i.test(
      prompt,
    )
  ) {
    signals.push({
      category: "workflow",
      key: "direct_root_cause_triaging",
      rule: "When diagnosing bugs or UI/app loading issues in monorepos: identify target app/surface first, then extract unhandled exception or network logs before modifying code/DB.",
      isCorrection: true,
      confidence: 0.95,
    });
  }

  return signals;
}
