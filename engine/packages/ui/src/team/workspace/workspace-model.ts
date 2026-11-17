import type { TeamAttemptView, TeamOwnerRead, TeamReviewView, TeamSeatView } from "@multi-agent/daemon/team-control";

/** The most recent attempt a seat ran; a seat that never ran has none. */
export function attemptForSeat(read: TeamOwnerRead | undefined, seat: TeamSeatView): TeamAttemptView | undefined {
  return read?.attempts.filter(attempt => attempt.session === seat.seat).at(-1);
}

/** The task a seat is working on now, otherwise its first unfinished task, otherwise its last. */
export function taskForSeat(read: TeamOwnerRead | undefined, seat: TeamSeatView): TeamReviewView | undefined {
  const tasks = read?.tasks.filter(task => task.seat === seat.seat) ?? [];
  const attempt = attemptForSeat(read, seat);
  return tasks.find(task => task.taskId === attempt?.taskId) ?? tasks.find(task => task.stage !== "done") ?? tasks.at(-1);
}