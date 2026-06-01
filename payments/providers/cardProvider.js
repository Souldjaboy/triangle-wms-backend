async function initiatePayment(payload) {
  if (payload.mode === "production") {
    return {
      status: "pending",
      message: "Provider carte prêt à brancher avec Stripe, CinetPay ou PayDunya.",
    };
  }

  return {
    status: "pending",
    sandbox: true,
    reference: payload.reference,
  };
}

async function verifyPayment() {
  return { status: "pending", sandbox: true };
}

async function handleWebhook(payload) {
  return { status: payload.status || "pending", payload };
}

async function cancelPayment() {
  return { status: "cancelled", sandbox: true };
}

module.exports = {
  initiatePayment,
  verifyPayment,
  handleWebhook,
  cancelPayment,
};
