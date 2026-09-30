package com.vertex.legacy.report;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.io.StringReader;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;

import org.junit.jupiter.api.Test;

class TaxLiabilityReportTest {
    @Test
    void appliesTheConfiguredFlatRateAndRoundsHalfUp() {
        TaxLiabilityReport report = new TaxLiabilityReport();

        assertEquals(new BigDecimal("11.14"), report.taxFor("VTX-10002", new BigDecimal("125.55")));
    }

    @Test
    void rejectsUnknownAccounts() {
        TaxLiabilityReport report = new TaxLiabilityReport();

        assertThrows(IllegalArgumentException.class,
                () -> report.taxFor("VTX-10999", new BigDecimal("100.00")));
    }

    @Test
    void printsTheQuarterlyCsvLiabilityRows() throws IOException {
        TaxLiabilityReport report = new TaxLiabilityReport();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (PrintStream output = new PrintStream(bytes, true, StandardCharsets.UTF_8.name())) {
            report.printReport(new BufferedReader(new StringReader(
                    "accountId,subtotal\nVTX-10004,1000.00\n")), output);
        }

        assertEquals("accountId,subtotal,tax\nVTX-10004,1000.00,130.00\n",
                bytes.toString(StandardCharsets.UTF_8.name()));
    }
}
