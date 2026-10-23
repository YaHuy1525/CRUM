interface ReceiptViewProps {
  receiptId: string
}

/**
 * Inline receipt display. Shows the signed receipt with signature
 * verification status. §11.3.
 */
export function ReceiptView({ receiptId }: ReceiptViewProps) {
  return (
    <div className="receipt-view">
      <h4>Receipt {receiptId}</h4>
      <p>Signature verification: pending integration</p>
    </div>
  )
}
