package com.parks.inventory.service;

import com.parks.inventory.domain.Hold;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * Posts each hold to the legacy ledger through the GnuCOBOL program HLDPOST
 * (resort-inventory/cobol/HLDPOST.cbl): one 40-byte fixed-width record on
 * stdin, one message line on stdout, RETURN-CODE as the exit status.
 */
@Component
public class LedgerPostingClient {

    private static final Logger log = LoggerFactory.getLogger(LedgerPostingClient.class);
    private static final DateTimeFormatter YYYYMMDD = DateTimeFormatter.BASIC_ISO_DATE;

    private final String executable;

    public LedgerPostingClient(@Value("${inventory.ledger.hldpost:/app/bin/HLDPOST}") String executable) {
        this.executable = executable;
    }

    public String post(Hold hold, char seasonCode, int basePriceUsd) {
        String record = String.format(Locale.ROOT, "%-8.8s%s%02d%c%05d%-16.16s",
                hold.getProductId().toUpperCase(Locale.ROOT), hold.getDate().format(YYYYMMDD),
                hold.getQuantity(), seasonCode, basePriceUsd, hold.getId());
        try {
            Process process = new ProcessBuilder(executable).redirectErrorStream(true).start();
            try (OutputStream in = process.getOutputStream()) {
                in.write((record + "\n").getBytes(StandardCharsets.US_ASCII));
            }
            String output;
            try (BufferedReader out = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.US_ASCII))) {
                output = out.readLine();
            }
            if (!process.waitFor(5, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new LedgerPostingException("HLDPOST timed out for hold " + hold.getId());
            }
            int rc = process.exitValue();
            String message = output == null ? "" : output.trim();
            if (rc != 0) {
                log.error("ledger.post_failed program=HLDPOST rc={} hold={} record=\"{}\" output=\"{}\"", rc, hold.getId(), record, message);
                throw new LedgerPostingException("HLDPOST rc=" + rc + ": " + message);
            }
            log.info("ledger.posted program=HLDPOST hold={} output=\"{}\"", hold.getId(), message);
            return message;
        } catch (LedgerPostingException e) {
            throw e;
        } catch (Exception e) {
            throw new LedgerPostingException("HLDPOST could not run: " + e.getMessage());
        }
    }
}
