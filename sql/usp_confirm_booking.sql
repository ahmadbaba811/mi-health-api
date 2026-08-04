SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[usp_confirm_booking]
(
    @holdId                 INT,
    @userId                 INT,
    @ref                    NVARCHAR(50),
    @totalPrice             NUMERIC(12,6),
    @isWalkIn               BIT,
    @homeAddress            NVARCHAR(MAX) = NULL,
    @postCode               NVARCHAR(50)  = NULL,
    @addOns                 NVARCHAR(50)  = NULL,
    @createdBy              NVARCHAR(255),
    @services               NVARCHAR(MAX),
    @walkInLabId            INT,
    @gatewayProvider        NVARCHAR(50),
    @gatewayTransactionId   NVARCHAR(255)
)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @bookingId INT,
        @labId     INT,
        @slotDate  DATE,
        @slotTime  TIME(0);

    BEGIN TRY
        --------------------------------------------------------
        -- Idempotency guard: if this gateway transaction was
        -- already recorded, don't double-process it.
        --------------------------------------------------------
        IF EXISTS (
            SELECT 1
            FROM payments
            WHERE gatewayProvider = @gatewayProvider
              AND gatewayTransactionId = @gatewayTransactionId
        )
        BEGIN
            SELECT 5 AS resultCode, NULL AS bookingId,
                   'This payment has already been processed.' AS reason;
            RETURN;
        END;

        --------------------------------------------------------
        -- Walk-in: no slot hold involved, book directly
        --------------------------------------------------------
        IF @isWalkIn = 1
        BEGIN
            INSERT INTO bookings
            (
                userId,
                ref,
                labId,
                totalPrice,
                status,
                isWalkIn,
                date,
                time,
                homeAddress,
                postCode,
                addOns,
                createdBy
            )
            VALUES
            (
                @userId,
                @ref,
                @walkInLabId,
                @totalPrice,
                'upcoming',
                1,
                NULL,
                NULL,
                @homeAddress,
                @postCode,
                @addOns,
                @createdBy
            );

            SET @bookingId = SCOPE_IDENTITY();

            INSERT INTO booking_services
            (
                bookingId,
                labServiceId,
                price,
                status,
                createdBy
            )
            SELECT
                @bookingId,
                JSON_VALUE(value, '$.id'),
                JSON_VALUE(value, '$.price'),
                'upcoming',
                @createdBy
            FROM OPENJSON(@services);

            SELECT 0 AS resultCode, @bookingId AS bookingId, 'Booking confirmed successfully.' AS reason;
            RETURN;
        END;

        --------------------------------------------------------
        -- Non walk-in: validate and lock the hold first
        --------------------------------------------------------
        SELECT
            @labId    = labId,
            @slotDate = slotDate,
            @slotTime = timeSlot
        FROM slot_holds WITH (UPDLOCK, ROWLOCK)
        WHERE id       = @holdId
          AND userId   = @userId
          AND status   = 'active'
          AND expiresAt > SYSUTCDATETIME();

        IF @labId IS NULL
        BEGIN
            SELECT 1 AS resultCode, NULL AS bookingId;
            RETURN;
        END;

        --------------------------------------------------------
        -- Create booking
        --------------------------------------------------------
        INSERT INTO bookings
        (
            userId,
            ref,
            labId,
            totalPrice,
            status,
            isWalkIn,
            date,
            time,
            homeAddress,
            postCode,
            addOns,
            createdBy
        )
        VALUES
        (
            @userId,
            @ref,
            @labId,
            @totalPrice,
            'upcoming',
            0,
            @slotDate,
            @slotTime,
            @homeAddress,
            @postCode,
            @addOns,
            @createdBy
        );

        SET @bookingId = SCOPE_IDENTITY();

        --------------------------------------------------------
        -- Booking services
        --------------------------------------------------------
        INSERT INTO booking_services
        (
            bookingId,
            labServiceId,
            price,
            status,
            createdBy
        )
        SELECT
            @bookingId,
            JSON_VALUE(value, '$.id'),
            JSON_VALUE(value, '$.price'),
            'upcoming',
            @createdBy
        FROM OPENJSON(@services);

        --------------------------------------------------------
        -- Confirm hold
        --------------------------------------------------------
        UPDATE slot_holds
        SET status = 'confirmed'
        WHERE id     = @holdId
          AND userId = @userId
          AND status = 'active';

        IF @@ROWCOUNT <> 1
        BEGIN
            SELECT 2 AS resultCode, NULL AS bookingId;
            RETURN;
        END;

        --------------------------------------------------------
        -- Refresh slot availability
        --------------------------------------------------------
        UPDATE tsa
        SET
            isAvailable =
            CASE
                WHEN
                (
                    (
                        SELECT COUNT(*)
                        FROM slot_holds sh
                        WHERE sh.labId    = tsa.labId
                          AND sh.slotDate = tsa.slotDate
                          AND sh.timeSlot = tsa.timeSlot
                          AND sh.status   = 'active'
                          AND sh.expiresAt > SYSUTCDATETIME()
                    )
                    +
                    (
                        SELECT COUNT(*)
                        FROM bookings b
                        WHERE b.labId  = tsa.labId
                          AND b.date   = tsa.slotDate
                          AND b.time   = tsa.timeSlot
                          AND b.status NOT IN ('cancelled', 'refunded')
                    )
                ) >= tsa.capacity
                THEN 0
                ELSE 1
            END,
            updatedAt = SYSUTCDATETIME()
        FROM time_slot_availability tsa
        WHERE tsa.labId    = @labId
          AND tsa.slotDate = @slotDate
          AND tsa.timeSlot = @slotTime;

        SELECT 0 AS resultCode, @bookingId AS bookingId, 'Booking confirmed successfully.' AS reason;
    END TRY
    BEGIN CATCH
        THROW;
    END CATCH
END;
GO
