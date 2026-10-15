*> HLDREC - inbound hold record (40 bytes), written by LedgerPostingClient
       01  HLD-REC.
           05 HLD-PRODUCT-ID           PIC X(08).
           05 HLD-PRODUCT-PARTS REDEFINES HLD-PRODUCT-ID.
              10 HLD-DESTINATION       PIC X(03).
              10 FILLER                PIC X(01).
              10 HLD-PRODUCT-CODE      PIC X(04).
           05 HLD-VISIT-DATE           PIC 9(08).
           05 HLD-QUANTITY             PIC 9(02).
           05 HLD-SEASON-CODE          PIC X(01).
           05 HLD-BASE-PRICE           PIC 9(05).
           05 HLD-HOLD-ID              PIC X(16).
