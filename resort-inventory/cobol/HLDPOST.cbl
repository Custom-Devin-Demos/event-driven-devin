      *>****************************************************************
      *> HLDPOST - TICKET / ROOM-NIGHT HOLD LEDGER POSTING
      *>
      *> Prices one cart hold and writes the fixed-width ledger line the
      *> nightly revenue reconciliation reads. Called once per hold by
      *> the resort-inventory service (LedgerPostingClient).
      *>
      *> INPUT  (stdin, one 40-byte record):
      *>   01-08  PRODUCT-ID      X(08)   e.g. WDW-MK
      *>   09-16  VISIT-DATE      9(08)   YYYYMMDD, park local date
      *>   17-18  QUANTITY        9(02)
      *>   19-19  SEASON-CODE     X(01)   rate season from the caller
      *>   20-24  BASE-PRICE      9(05)   whole USD per unit
      *>   25-40  HOLD-ID         X(16)
      *> OUTPUT (stdout): HLD0000I POSTED <ledger line>, RETURN-CODE 0
      *> ERRORS: HLDnnnnE message on stdout, RETURN-CODE 8/12/16
      *>
      *> SEASON-RATE-TABLE holds one row per rate season the ledger can
      *> price. Revenue Management owns the multipliers.
      *>****************************************************************
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
       01  HOLD-IN-REC                 PIC X(40).

       WORKING-STORAGE SECTION.
       01  WS-HOLD.
           05 WS-PRODUCT-ID            PIC X(08).
           05 WS-VISIT-DATE            PIC 9(08).
           05 WS-QUANTITY              PIC 9(02).
           05 WS-SEASON-CODE           PIC X(01).
           05 WS-BASE-PRICE            PIC 9(05).
           05 WS-HOLD-ID               PIC X(16).

       01  SEASON-RATE-VALUES.
           05 FILLER                   PIC X(05) VALUE "V0950".
           05 FILLER                   PIC X(05) VALUE "R1000".
       01  SEASON-RATE-TABLE REDEFINES SEASON-RATE-VALUES.
           05 SEASON-RATE OCCURS 2 TIMES INDEXED BY SR-IDX.
              10 SR-CODE               PIC X(01).
              10 SR-MULTIPLIER         PIC 9V999.

       01  WS-UNIT-PRICE               PIC 9(05)V99.
       01  WS-AMOUNT                   PIC 9(07)V99.
       01  WS-AMOUNT-OUT               PIC Z(06)9.99.
       01  WS-EOF                      PIC X VALUE "N".

       PROCEDURE DIVISION.
       MAIN-PARA.
           OPEN INPUT HOLD-IN
           READ HOLD-IN
               AT END MOVE "Y" TO WS-EOF
           END-READ
           IF WS-EOF = "Y"
               DISPLAY "HLD0010E NO INPUT RECORD"
               MOVE 8 TO RETURN-CODE
               GO TO END-PARA
           END-IF
           MOVE HOLD-IN-REC TO WS-HOLD

           IF WS-VISIT-DATE IS NOT NUMERIC
              OR WS-QUANTITY IS NOT NUMERIC
              OR WS-BASE-PRICE IS NOT NUMERIC
               DISPLAY "HLD0020E INVALID NUMERIC FIELD IN HOLD "
                   WS-HOLD-ID
               MOVE 12 TO RETURN-CODE
               GO TO END-PARA
           END-IF

           SET SR-IDX TO 1
           SEARCH SEASON-RATE
               AT END
                   DISPLAY "HLD0042E NO RATE ENTRY FOR SEASON "
                       WS-SEASON-CODE " HOLD " WS-HOLD-ID
                   MOVE 16 TO RETURN-CODE
                   GO TO END-PARA
               WHEN SR-CODE (SR-IDX) = WS-SEASON-CODE
                   CONTINUE
           END-SEARCH

           COMPUTE WS-UNIT-PRICE ROUNDED =
               WS-BASE-PRICE * SR-MULTIPLIER (SR-IDX)
           COMPUTE WS-AMOUNT = WS-UNIT-PRICE * WS-QUANTITY
           MOVE WS-AMOUNT TO WS-AMOUNT-OUT
           DISPLAY "HLD0000I POSTED " WS-HOLD-ID " " WS-PRODUCT-ID " "
               WS-VISIT-DATE " " WS-SEASON-CODE " QTY " WS-QUANTITY
               " AMT " WS-AMOUNT-OUT
           MOVE 0 TO RETURN-CODE.

       END-PARA.
           CLOSE HOLD-IN
           STOP RUN.
