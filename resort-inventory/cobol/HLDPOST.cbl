*>*****************************************************************
*> HLDPOST - TICKET / ROOM-NIGHT HOLD LEDGER POSTING
*>
*> Prices one cart hold and writes the fixed-width revenue ledger
*> line (LEDGREC) that the nightly reconciliation reads. Called once
*> per hold by the resort-inventory service (LedgerPostingClient).
*>
*> INPUT  : one 40-byte HLDREC record on stdin
*> OUTPUT : HLD0000I POSTED <ledger line>      RETURN-CODE 0
*>          HLD0001I AUDIT  <trailer>
*> ERRORS : HLDnnnnE <message>                 RETURN-CODE 8/12/16
*>   HLD0010E no input record                  RC 08
*>   HLD0020E non-numeric date/qty/price       RC 12
*>   HLD0021E visit date is not a calendar day RC 12
*>   HLD0030E quantity outside 1-10            RC 12
*>   HLD0040E product not in PRODUCT table     RC 12
*>   HLD0042E no rate entry for season         RC 16
*>   HLD0050E no tax entry for jurisdiction    RC 16
*>   HLD0060E amount overflow                  RC 12
*>
*> RATE TABLES - owned by Revenue Management. Add a SEASON-RATE row
*> (and bump its OCCURS) before a caller sends a new season code.
*>
*> CHANGE LOG
*>   2009-03  initial version (park tickets only)
*>   2013-11  room-nights for Deluxe resort hotels, resort tax rows
*>   2016-06  Disneyland Resort jurisdictions (Anaheim TOT + TMD)
*>   2019-02  VALUE season multiplier
*>*****************************************************************
IDENTIFICATION DIVISION.
PROGRAM-ID. HLDPOST.

ENVIRONMENT DIVISION.
INPUT-OUTPUT SECTION.
FILE-CONTROL.
    SELECT HOLD-IN ASSIGN TO KEYBOARD
        ORGANIZATION IS LINE SEQUENTIAL.

DATA DIVISION.
FILE SECTION.
FD  HOLD-IN.
01  HOLD-IN-REC                     PIC X(40).

WORKING-STORAGE SECTION.
COPY HLDREC.
COPY LEDGREC.

*> Rate season multipliers (V = value, R = regular)
01  SEASON-RATE-VALUES.
    05 FILLER                       PIC X(05) VALUE "V0950".
    05 FILLER                       PIC X(05) VALUE "R1000".
01  SEASON-RATE-TABLE REDEFINES SEASON-RATE-VALUES.
    05 SEASON-RATE OCCURS 2 TIMES INDEXED BY SR-IDX.
       10 SR-CODE                   PIC X(01).
       10 SR-MULTIPLIER             PIC 9V999.

*> Products: code, class (T = park ticket + Park Pass, R = room-night)
01  PRODUCT-VALUES.
    05 FILLER                       PIC X(12) VALUE "WDW-MK  T   ".
    05 FILLER                       PIC X(12) VALUE "WDW-EP  T   ".
    05 FILLER                       PIC X(12) VALUE "WDW-HS  T   ".
    05 FILLER                       PIC X(12) VALUE "WDW-AK  T   ".
    05 FILLER                       PIC X(12) VALUE "DLR-DL  T   ".
    05 FILLER                       PIC X(12) VALUE "DLR-DCA T   ".
    05 FILLER                       PIC X(12) VALUE "WDW-GF  R   ".
    05 FILLER                       PIC X(12) VALUE "WDW-POLYR   ".
    05 FILLER                       PIC X(12) VALUE "WDW-CR  R   ".
    05 FILLER                       PIC X(12) VALUE "DLR-GC  R   ".
    05 FILLER                       PIC X(12) VALUE "DLR-DLH R   ".
01  PRODUCT-TABLE REDEFINES PRODUCT-VALUES.
    05 PRODUCT-ENTRY OCCURS 11 TIMES INDEXED BY PR-IDX.
       10 PR-ID                     PIC X(08).
       10 PR-CLASS                  PIC X(01).
       10 FILLER                    PIC X(03).

*> Tax: destination + class -> jurisdiction label, rate (9V9999)
01  TAX-VALUES.
    05 FILLER                       PIC X(17) VALUE "WDWTORANGE-FL0650".
    05 FILLER                       PIC X(17) VALUE "WDWRORANGE-RT1250".
    05 FILLER                       PIC X(17) VALUE "DLRTANAHEIM  0000".
    05 FILLER                       PIC X(17) VALUE "DLRRANAHEIM-T1700".
01  TAX-TABLE REDEFINES TAX-VALUES.
    05 TAX-ENTRY OCCURS 4 TIMES INDEXED BY TX-IDX.
       10 TX-DESTINATION            PIC X(03).
       10 TX-CLASS                  PIC X(01).
       10 TX-JURISDICTION           PIC X(09).
       10 TX-RATE                   PIC 9V999.

01  WS-WORK.
    05 WS-EOF                       PIC X(01) VALUE "N".
    05 WS-CLASS                     PIC X(01).
    05 WS-UNIT-PRICE                PIC 9(05)V99.
    05 WS-NET                       PIC 9(07)V99.
    05 WS-TAX                       PIC 9(06)V99.
    05 WS-GROSS                     PIC 9(07)V99.
    05 WS-DATE-CHECK                PIC S9(09) COMP.
    05 WS-TIMESTAMP                 PIC X(21).

PROCEDURE DIVISION.
0000-MAIN.
    PERFORM 1000-READ-HOLD
    PERFORM 2000-VALIDATE
    PERFORM 3000-CLASSIFY-PRODUCT
    PERFORM 4000-RATE-SEASON
    PERFORM 5000-PRICE
    PERFORM 6000-TAX
    PERFORM 7000-WRITE-LEDGER
    MOVE 0 TO RETURN-CODE
    PERFORM 9000-FINISH.

1000-READ-HOLD.
    OPEN INPUT HOLD-IN
    READ HOLD-IN
        AT END MOVE "Y" TO WS-EOF
    END-READ
    IF WS-EOF = "Y"
        DISPLAY "HLD0010E NO INPUT RECORD"
        MOVE 8 TO RETURN-CODE
        PERFORM 9000-FINISH
    END-IF
    MOVE HOLD-IN-REC TO HLD-REC.

2000-VALIDATE.
    IF HLD-VISIT-DATE IS NOT NUMERIC
       OR HLD-QUANTITY IS NOT NUMERIC
       OR HLD-BASE-PRICE IS NOT NUMERIC
        DISPLAY "HLD0020E INVALID NUMERIC FIELD HOLD " HLD-HOLD-ID
        MOVE 12 TO RETURN-CODE
        PERFORM 9000-FINISH
    END-IF
    MOVE FUNCTION TEST-DATE-YYYYMMDD (HLD-VISIT-DATE) TO WS-DATE-CHECK
    IF WS-DATE-CHECK NOT = 0
        DISPLAY "HLD0021E INVALID VISIT DATE " HLD-VISIT-DATE
            " HOLD " HLD-HOLD-ID
        MOVE 12 TO RETURN-CODE
        PERFORM 9000-FINISH
    END-IF
    IF HLD-QUANTITY < 1 OR HLD-QUANTITY > 10
        DISPLAY "HLD0030E QUANTITY " HLD-QUANTITY " OUTSIDE 1-10 HOLD "
            HLD-HOLD-ID
        MOVE 12 TO RETURN-CODE
        PERFORM 9000-FINISH
    END-IF.

3000-CLASSIFY-PRODUCT.
    SET PR-IDX TO 1
    SEARCH PRODUCT-ENTRY
        AT END
            DISPLAY "HLD0040E UNKNOWN PRODUCT " HLD-PRODUCT-ID
                " HOLD " HLD-HOLD-ID
            MOVE 12 TO RETURN-CODE
            PERFORM 9000-FINISH
        WHEN PR-ID (PR-IDX) = HLD-PRODUCT-ID
            MOVE PR-CLASS (PR-IDX) TO WS-CLASS
    END-SEARCH.

4000-RATE-SEASON.
    SET SR-IDX TO 1
    SEARCH SEASON-RATE
        AT END
            DISPLAY "HLD0042E NO RATE ENTRY FOR SEASON " HLD-SEASON-CODE
                " HOLD " HLD-HOLD-ID
            MOVE 16 TO RETURN-CODE
            PERFORM 9000-FINISH
        WHEN SR-CODE (SR-IDX) = HLD-SEASON-CODE
            CONTINUE
    END-SEARCH.

5000-PRICE.
    COMPUTE WS-UNIT-PRICE ROUNDED =
        HLD-BASE-PRICE * SR-MULTIPLIER (SR-IDX)
    COMPUTE WS-NET ROUNDED = WS-UNIT-PRICE * HLD-QUANTITY
        ON SIZE ERROR
            DISPLAY "HLD0060E AMOUNT OVERFLOW HOLD " HLD-HOLD-ID
            MOVE 12 TO RETURN-CODE
            PERFORM 9000-FINISH
    END-COMPUTE.

6000-TAX.
    SET TX-IDX TO 1
    SEARCH TAX-ENTRY
        AT END
            DISPLAY "HLD0050E NO TAX ENTRY FOR " HLD-DESTINATION
                "/" WS-CLASS " HOLD " HLD-HOLD-ID
            MOVE 16 TO RETURN-CODE
            PERFORM 9000-FINISH
        WHEN TX-DESTINATION (TX-IDX) = HLD-DESTINATION
         AND TX-CLASS (TX-IDX) = WS-CLASS
            CONTINUE
    END-SEARCH
    COMPUTE WS-TAX ROUNDED = WS-NET * TX-RATE (TX-IDX) / 10
    COMPUTE WS-GROSS = WS-NET + WS-TAX
        ON SIZE ERROR
            DISPLAY "HLD0060E AMOUNT OVERFLOW HOLD " HLD-HOLD-ID
            MOVE 12 TO RETURN-CODE
            PERFORM 9000-FINISH
    END-COMPUTE.

7000-WRITE-LEDGER.
    MOVE HLD-HOLD-ID          TO LDG-HOLD-ID
    MOVE HLD-PRODUCT-ID       TO LDG-PRODUCT-ID
    MOVE WS-CLASS             TO LDG-CLASS
    MOVE HLD-VISIT-DATE       TO LDG-VISIT-DATE
    MOVE HLD-SEASON-CODE      TO LDG-SEASON
    MOVE HLD-QUANTITY         TO LDG-QUANTITY
    MOVE WS-NET               TO LDG-NET
    MOVE WS-TAX               TO LDG-TAX
    MOVE WS-GROSS             TO LDG-GROSS
    MOVE TX-JURISDICTION (TX-IDX) TO LDG-JURISDICTION
    MOVE FUNCTION CURRENT-DATE TO WS-TIMESTAMP
    DISPLAY "HLD0000I POSTED " LEDGER-LINE
    DISPLAY "HLD0001I AUDIT " WS-TIMESTAMP (1:14) " HLDPOST "
        HLD-HOLD-ID " RC 0000".

9000-FINISH.
    CLOSE HOLD-IN
    STOP RUN.
