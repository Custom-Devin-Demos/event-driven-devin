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

    public char seasonFor(LocalDate date) {
        Month month = date.getMonth();
        boolean midweek = date.getDayOfWeek().getValue() <= 4;
        if ((month == Month.JANUARY && date.getDayOfMonth() > 6) || month == Month.FEBRUARY
                || (month == Month.SEPTEMBER && midweek)) {
            return VALUE;
        }
        return REGULAR;
    }
}
