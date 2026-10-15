*> LEDGREC - revenue ledger line read by the nightly reconciliation
       01  LEDGER-LINE.
           05 LDG-HOLD-ID              PIC X(16).
           05 FILLER                   PIC X(01) VALUE SPACE.
           05 LDG-PRODUCT-ID           PIC X(08).
           05 FILLER                   PIC X(01) VALUE SPACE.
           05 LDG-CLASS                PIC X(01).
           05 FILLER                   PIC X(01) VALUE SPACE.
           05 LDG-VISIT-DATE           PIC 9(08).
           05 FILLER                   PIC X(01) VALUE SPACE.
           05 LDG-SEASON               PIC X(01).
           05 FILLER                   PIC X(01) VALUE SPACE.
           05 LDG-QUANTITY             PIC 9(02).
           05 FILLER                   PIC X(05) VALUE " NET ".
           05 LDG-NET                  PIC Z(06)9.99.
           05 FILLER                   PIC X(05) VALUE " TAX ".
           05 LDG-TAX                  PIC Z(05)9.99.
           05 FILLER                   PIC X(07) VALUE " GROSS ".
           05 LDG-GROSS                PIC Z(06)9.99.
           05 FILLER                   PIC X(05) VALUE " JUR ".
           05 LDG-JURISDICTION         PIC X(09).
