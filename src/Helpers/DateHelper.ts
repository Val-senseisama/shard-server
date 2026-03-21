/**
 * Parse human-readable duration string to milliseconds
 * Examples: "2 days", "1 week", "3 hours", "30 minutes"
 */
export function parseDurationToMs(duration: string): number {
    const match = duration.match(/(\d+)\s*(hour|day|week|month|year|minute)s?/i);

    if (!match) {
        return 24 * 60 * 60 * 1000; // Default to 1 day
    }

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    const msMap: Record<string, number> = {
        minute: 60 * 1000,
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
        year: 365 * 24 * 60 * 60 * 1000,
    };

    return value * (msMap[unit] || msMap.day);
}

/**
 * Calculate due date from start date and duration string
 */
export function calculateDueDate(startDate: Date, duration: string): Date {
    const ms = parseDurationToMs(duration);
    return new Date(startDate.getTime() + ms);
}

/**
 * Distribute dates evenly across a timeline
 */
export function distributeDatesEvenly(
    startDate: Date,
    endDate: Date,
    count: number
): Date[] {
    const totalMs = endDate.getTime() - startDate.getTime();
    const intervalMs = totalMs / count;

    return Array.from({ length: count }, (_, i) =>
        new Date(startDate.getTime() + intervalMs * (i + 1))
    );
}
