SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[usp_record_payment]
(
    @ref                    NVARCHAR(50),
    @userId                 INT,
    @subTotal               NUMERIC(12,6),
    @currency               NVARCHAR(10) = 'GBP',

    @gatewayStatus          NVARCHAR(50),
    @gatewayProvider        NVARCHAR(50),
    @gatewayTransactionId   NVARCHAR(255),
    @gatewayReference       NVARCHAR(255),
    @serviceFee             NUMERIC(12,6) = NULL,
    @VAT                    NUMERIC(12,6) = NULL,
    @createdBy              NVARCHAR(255),
    @lineItems              NVARCHAR(MAX) = NULL
)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @paymentId INT,
        @lineItemTotal NUMERIC(12,6);

    --------------------------------------------------------
    -- Prevent duplicate payment processing
    --------------------------------------------------------
    IF EXISTS
    (
        SELECT 1
        FROM payments
        WHERE gatewayProvider = @gatewayProvider
          AND gatewayTransactionId = @gatewayTransactionId
    )
    BEGIN
        SELECT
            5 AS resultCode,
            NULL AS paymentId,
            'This payment has already been processed.' AS reason;

        RETURN;
    END;

    --------------------------------------------------------
    -- Validate line item total
    --------------------------------------------------------
    SELECT
        @lineItemTotal =
            SUM(
                CAST(JSON_VALUE(value,'$.amount') AS NUMERIC(12,6))
            )
    FROM OPENJSON(@lineItems);

    IF ISNULL(@lineItemTotal,0) <> @subTotal
    BEGIN
        SELECT
            6 AS resultCode,
            NULL AS paymentId,
            'Line items do not sum to the total charged.' AS reason;

        RETURN;
    END;

    --------------------------------------------------------
    -- Ensure referenced bookings exist
    --------------------------------------------------------
    IF EXISTS
    (
        SELECT 1
        FROM OPENJSON(@lineItems)
        WHERE JSON_VALUE(value,'$.bookingId') IS NOT NULL
        AND NOT EXISTS
        (
            SELECT 1
            FROM bookings b
            WHERE b.id = TRY_CAST(JSON_VALUE(value,'$.bookingId') AS INT)
        )
    )
    BEGIN
        SELECT
            7 AS resultCode,
            NULL AS paymentId,
            'One or more bookingIds are invalid.' AS reason;

        RETURN;
    END;

    --------------------------------------------------------
    -- Create payment
    --------------------------------------------------------
    INSERT INTO payments
    (
        ref,
        userId,
        amount,
        serviceFee,
        VAT,
        currency,
        gatewayStatus,
        gatewayProvider,
        gatewayTransactionId,
        gatewayReference,
        status,
        createdBy
    )
    VALUES
    (
        @ref,
        @userId,
        @subTotal,
        @serviceFee,
        @VAT,
        @currency,
        @gatewayStatus,
        @gatewayProvider,
        @gatewayTransactionId,
        @gatewayReference,
        'paid',
        @createdBy
    );

    SET @paymentId = SCOPE_IDENTITY();

    --------------------------------------------------------
    -- Create payment breakdown
    --------------------------------------------------------
    INSERT INTO payment_line_items
    (
        ref,
        labId,
        paymentId,
        bookingId,
        type,
        amount,
        addOnId,
        description
    )
    SELECT
        @ref,
        TRY_CAST(JSON_VALUE(value,'$.labId') AS INT),
        @paymentId,
        TRY_CAST(JSON_VALUE(value,'$.bookingId') AS INT),
        JSON_VALUE(value,'$.type'),
        CAST(JSON_VALUE(value,'$.amount') AS NUMERIC(12,6)),
        TRY_CAST(JSON_VALUE(value,'$.addOnId') AS INT),
        JSON_VALUE(value,'$.description')
    FROM OPENJSON(@lineItems);

    SELECT
        0 AS resultCode,
        @paymentId AS paymentId,
        'Payment recorded successfully.' AS reason;
END;
GO
