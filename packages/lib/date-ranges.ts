import type { Dayjs } from "@calcom/dayjs";
import dayjs from "@calcom/dayjs";
import type { Availability } from "@calcom/prisma/client";

export type DateRange = {
  start: Dayjs;
  end: Dayjs;
};

export type DateOverride = Pick<Availability, "date" | "startTime" | "endTime">;
export type WorkingHours = Pick<Availability, "days" | "startTime" | "endTime">;

export function processWorkingHours({
  item,
  timeZone,
  dateFrom,
  dateTo,
}: {
  item: WorkingHours;
  timeZone: string;
  dateFrom: Dayjs;
  dateTo: Dayjs;
}) {
  const results = [];
  for (
    // Cast dateFrom from booker TZ -> organizer TZ
    let date = dateFrom.tz(timeZone).startOf("day").toDate();
    dateTo.toDate() > date;
    date = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + 1,
      date.getHours(),
      date.getMinutes(),
      date.getSeconds()
    )
  ) {
    // Checking the date has to be timeZone aware.
    const utcOffset = dayjs(date).tz(timeZone).utcOffset();

    const dateInTz = new Date(date.valueOf() + utcOffset * 60 * 1000);

    if (!item.days.includes(dateInTz.getUTCDay())) {
      continue;
    }
    // Date (start of day) in organizer TZ is then added the start and end times.
    const start = new Date(
      date.valueOf() +
        item.startTime.getUTCHours() * 60 * 60 * 1000 +
        item.startTime.getUTCMinutes() * 60 * 1000
    );

    const end = new Date(
      date.valueOf() + item.endTime.getUTCHours() * 60 * 60 * 1000 + item.endTime.getUTCMinutes() * 60 * 1000
    );

    const startResult = start.valueOf() > dateFrom.valueOf() ? start : dateFrom;
    const endResult = end.valueOf() < dateTo.valueOf() ? end : dateTo;

    if (startResult >= endResult) {
      // if an event ends before start, it's not a result.
      continue;
    }

    results.push({
      start: dayjs(startResult).tz(timeZone),
      end: dayjs(endResult).tz(timeZone),
    });
  }
  return results;
}

export function processDateOverride({ item, timeZone }: { item: DateOverride; timeZone: string }) {
  const startDate = dayjs
    .utc(item.date)
    .startOf("day")
    .add(item.startTime.getUTCHours(), "hours")
    .add(item.startTime.getUTCMinutes(), "minutes")
    .second(0)
    .tz(timeZone, true);
  const endDate = dayjs
    .utc(item.date)
    .startOf("day")
    .add(item.endTime.getUTCHours(), "hours")
    .add(item.endTime.getUTCMinutes(), "minutes")
    .second(0)
    .tz(timeZone, true);
  return {
    start: startDate,
    end: endDate,
  };
}

export function buildDateRanges({
  availability,
  timeZone /* Organizer timeZone */,
  dateFrom /* Attendee dateFrom */,
  dateTo /* `` dateTo */,
}: {
  timeZone: string;
  availability: (DateOverride | WorkingHours)[];
  dateFrom: Dayjs;
  dateTo: Dayjs;
}): DateRange[] {
  const groupedWorkingHours = groupByDate(
    availability.reduce((processed: DateRange[], item) => {
      if ("days" in item) {
        processed = processed.concat(processWorkingHours({ item, timeZone, dateFrom, dateTo }));
      }
      return processed;
    }, [])
  );
  const groupedDateOverrides = groupByDate(
    availability.reduce((processed: DateRange[], item) => {
      if ("date" in item && !!item.date) {
        processed.push(processDateOverride({ item, timeZone }));
      }
      return processed;
    }, [])
  );

  const dateRanges = Object.values({
    ...groupedWorkingHours,
    ...groupedDateOverrides,
  }).map(
    // remove 0-length overrides that were kept to cancel out working dates until now.
    (ranges) => ranges.filter((range) => range.start.valueOf() !== range.end.valueOf())
  );

  return dateRanges.flat();
}

export function groupByDate(ranges: DateRange[]): { [x: string]: DateRange[] } {
  const results = ranges.reduce(
    (
      previousValue: {
        [date: string]: DateRange[];
      },
      currentValue
    ) => {
      const dateString = dayjs(currentValue.start).format("YYYY-MM-DD");

      previousValue[dateString] =
        typeof previousValue[dateString] === "undefined"
          ? [currentValue]
          : [...previousValue[dateString], currentValue];
      return previousValue;
    },
    {}
  );

  return results;
}

export function intersect(ranges: DateRange[][]): DateRange[] {
  if (!ranges.length) return [];
  // Get the ranges of the first user
  let commonAvailability = ranges[0];

  // For each of the remaining users, find the intersection of their ranges with the current common availability
  for (let i = 1; i < ranges.length; i++) {
    const userRanges = ranges[i];

    const intersectedRanges: {
      start: Dayjs;
      end: Dayjs;
    }[] = [];

    commonAvailability.forEach((commonRange) => {
      userRanges.forEach((userRange) => {
        const intersection = getIntersection(commonRange, userRange);
        if (intersection !== null) {
          // If the current common range intersects with the user range, add the intersected time range to the new array
          intersectedRanges.push(intersection);
        }
      });
    });

    commonAvailability = intersectedRanges;
  }

  // If the common availability is empty, there is no time when all users are available
  if (commonAvailability.length === 0) {
    return [];
  }

  return commonAvailability;
}

function getIntersection(range1: DateRange, range2: DateRange) {
  const start = range1.start.utc().isAfter(range2.start) ? range1.start : range2.start;
  const end = range1.end.utc().isBefore(range2.end) ? range1.end : range2.end;
  if (start.utc().isBefore(end)) {
    return { start, end };
  }
  return null;
}

export function subtract(
  sourceRanges: (DateRange & { [x: string]: unknown })[],
  excludedRanges: DateRange[]
) {
  const result: DateRange[] = [];

  for (const { start: sourceStart, end: sourceEnd, ...passThrough } of sourceRanges) {
    let currentStart = sourceStart;

    const overlappingRanges = excludedRanges.filter(
      ({ start, end }) => start.isBefore(sourceEnd) && end.isAfter(sourceStart)
    );

    overlappingRanges.sort((a, b) => (a.start.isAfter(b.start) ? 1 : -1));

    for (const { start: excludedStart, end: excludedEnd } of overlappingRanges) {
      if (excludedStart.isAfter(currentStart)) {
        result.push({ start: currentStart, end: excludedStart });
      }
      currentStart = excludedEnd.isAfter(currentStart) ? excludedEnd : currentStart;
    }

    if (sourceEnd.isAfter(currentStart)) {
      result.push({ start: currentStart, end: sourceEnd, ...passThrough });
    }
  }

  return result;
}
