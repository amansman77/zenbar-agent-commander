// Default (empty) answers for a task's pending questions form.

import type {
  TaskQuestion
} from "@zenbar/shared";

export function defaultAnswers(questions: TaskQuestion[]): Record<string, string> {
  return Object.fromEntries(questions.map((question) => [question.id, ""]));
}
