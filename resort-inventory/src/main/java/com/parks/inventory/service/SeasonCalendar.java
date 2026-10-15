package com.parks.inventory.service;

import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.Month;

/**
 * Rate season for a visit date. The code is passed to the HLDPOST ledger
 * program, which prices the hold with that season's multiplier.
 */
@Component
public class SeasonCalendar {

    public static final char VALUE = 'V';
    public static final char REGULAR = 'R';
    /** Thanksgiving week and the Christmas-New Year holiday weeks (INV-2291). */
    public static final char PEAK = 'P';

    public char seasonFor(LocalDate date) {
        if (isPeak(date)) {
            return PEAK;
        }
        Month month = date.getMonth();
        boolean midweek = date.getDayOfWeek().getValue() <= 4;
        if ((month == Month.JANUARY && date.getDayOfMonth() > 6) || month == Month.FEBRUARY
                || (month == Month.SEPTEMBER && midweek)) {
            return VALUE;
        }
        return REGULAR;
    }

    static boolean isPeak(LocalDate date) {
        if (date.getMonth() == Month.DECEMBER && date.getDayOfMonth() >= 20) return true;
        if (date.getMonth() == Month.JANUARY && date.getDayOfMonth() <= 1) return true;
        LocalDate thanksgiving = date.withMonth(11).withDayOfMonth(1);
        while (thanksgiving.getDayOfWeek() != java.time.DayOfWeek.THURSDAY) thanksgiving = thanksgiving.plusDays(1);
        thanksgiving = thanksgiving.plusWeeks(3);
        return !date.isBefore(thanksgiving.minusDays(3)) && !date.isAfter(thanksgiving.plusDays(3));
    }
}
