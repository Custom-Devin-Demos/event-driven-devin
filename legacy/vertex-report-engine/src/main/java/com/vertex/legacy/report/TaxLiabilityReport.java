package com.vertex.legacy.report;

import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.util.Properties;

public class TaxLiabilityReport {
    private static final BigDecimal ONE_HUNDRED = new BigDecimal("100");
    private final Properties accountTaxRates = new Properties();

    public TaxLiabilityReport() {
        try (InputStream stream = TaxLiabilityReport.class.getResourceAsStream("/account-tax-rates.properties")) {
            if (stream == null) {
                throw new IllegalStateException("Missing account-tax-rates.properties");
            }
            accountTaxRates.load(new InputStreamReader(stream, StandardCharsets.UTF_8));
        } catch (IOException error) {
            throw new IllegalStateException("Unable to load account tax rates", error);
        }
    }

    public BigDecimal taxFor(String accountId, BigDecimal subtotal) {
        String configuredRate = accountTaxRates.getProperty(accountId);
        if (configuredRate == null) {
            throw new IllegalArgumentException("Unknown account: " + accountId);
        }
        return subtotal.multiply(new BigDecimal(configuredRate))
                .divide(ONE_HUNDRED, 2, RoundingMode.HALF_UP);
    }

    public void printReport(BufferedReader csv, PrintStream output) throws IOException {
        output.println("accountId,subtotal,tax");
        String line;
        while ((line = csv.readLine()) != null) {
            if (line.trim().isEmpty() || line.startsWith("accountId,")) {
                continue;
            }
            String[] fields = line.split(",", 2);
            if (fields.length != 2) {
                throw new IllegalArgumentException("Expected accountId,subtotal row: " + line);
            }
            BigDecimal subtotal = new BigDecimal(fields[1].trim());
            output.println(fields[0].trim() + "," + subtotal.setScale(2, RoundingMode.HALF_UP)
                    + "," + taxFor(fields[0].trim(), subtotal));
        }
    }

    public static void main(String[] args) throws IOException {
        if (args.length != 1) {
            throw new IllegalArgumentException("Usage: TaxLiabilityReport <quarterly-invoices.csv>");
        }
        TaxLiabilityReport report = new TaxLiabilityReport();
        try (BufferedReader csv = new BufferedReader(new FileReader(args[0]))) {
            report.printReport(csv, System.out);
        }
    }
}
