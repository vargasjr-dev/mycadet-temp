How your assistant pays for things on your behalf through your Link account, with every purchase capped at an amount you approve.

## Overview

Your assistant can buy things for you. It does this through [Link](https://stripe.com/payments/link), Stripe's wallet, rather than with a card number you paste into chat. You connect your Link account once. When a task calls for a purchase, your assistant sends you a spend request naming the merchant, the amount, and what the money is for. You approve it in the Link app, Link issues a single-use virtual card for that amount, and your assistant completes the checkout. Your saved cards stay in Link. The assistant never sees them.

This is what lets your assistant finish a task end to end: order supplies, renew a subscription, pay for an API call, or book something, without stopping to hand a checkout page back to you. You set the amount, and you approve every purchase. Link describes the agent side of this on its [Link for agents](https://link.com/agents) page.

## How a purchase works

1. **You ask.** For example, "Order a replacement laptop charger, up to $60." The amount you name is the most your assistant will request.
2. **Your assistant drafts a spend request.** It names the merchant, the amount, and a plain-language description of what it is buying and why. The description is written for you to read at approval time.
3. **You approve in the Link app.** Link notifies you. The request shows your assistant's name, the merchant, the amount, and the description. You have ten minutes to approve or decline. Nothing is charged until you approve.
4. **Link issues a single-use credential.** For an ordinary online store, that is a virtual Visa or Mastercard for the approved amount. For a merchant that accepts agent payments directly, it is a shared payment token.
5. **Your assistant checks out.** It fills the card into the merchant's checkout with its browser, or sends the token to the merchant's payment endpoint, then reports back with the confirmation.
6. **The purchase lands in your Link history**, labeled with your assistant's name, so you can review it later alongside everything else you have paid for with Link.

If your assistant runs into a checkout page during some other task, it routes the payment through Link the same way instead of handing you the link to finish yourself.

## Connecting your Link account

```docs-video
agentic-payments-link-wallet
```

You need two things first: a Link account with at least one saved payment method, and the Link app on your phone, which is where you approve requests. You can add a payment method at [app.link.com/wallet](https://app.link.com/wallet).

The fastest way to connect is to ask your assistant:

```
"Connect my Link wallet"
```

A connect card appears in the conversation. Sign in to Link, grant access, and you are done. You can also connect through Settings:

1. Open **Settings** in your Cadet app.
2. Navigate to the **Integrations** tab.
3. Find **Link by Stripe** and click **Connect**.
4. Sign in to Link in the window that opens and grant access.

The connection asks Link for two permissions: create single-use cards and payment tokens against your wallet, and read your wallet profile (name, email, and phone). It cannot read your saved card numbers.

The connection runs through Cadet's cloud OAuth, so it needs an assistant that is connected to Cadet Cloud. If yours is not, your assistant falls back to Link's own device login: it shows you a link and a short phrase, and you approve the connection in the Link app. Purchases work the same way either way.

## What keeps you in control

- **Approval before every purchase.** No card or token is issued until you approve that specific request in the Link app. Decline it and nothing happens.
- **An amount you set.** Each credential is issued for the approved amount. Link caps a single spend request at $500, so anything larger has to be split or handled by you.
- **Single-use credentials.** A card or token covers one checkout. If the checkout fails, the credential is spent and your assistant has to send you a new request. Approved credentials expire twelve hours after the request is created.
- **Your real cards stay in Link.** Your assistant never sees your saved card numbers. The Link connection itself lives in your assistant's credential vault and is attached to requests at the transport layer, like every other OAuth integration, so neither the model nor the shell holds a Link token.
- **A description you can read.** Every request carries a description of what is being bought and why. If it does not match what you asked for, decline it.
- **Real money only when you say so.** Your assistant starts in Link's test mode, which produces approvals and test cards that never charge your payment method. It moves to live payments only after you explicitly tell it to spend real money, and it asks first when it is unsure.
- **Review and revoke.** Purchase history in Link lists every agent purchase with its status, payment method, and the assistant that made it. Disconnect Link from Settings, or by asking your assistant, and the stored connection is removed immediately. You can also revoke access from your Link account.

For how connections are stored and what the assistant can and cannot reach, see [OAuth Integrations](/docs/key-concepts/oauth-integrations) and [The Permissions Model](/docs/trust-security/the-permissions-model).

## Cards and payment tokens

Link issues one of two credentials for an approved request. You do not choose between them. Your assistant picks based on what the merchant supports, and both go through the same approval.

| Credential               | When it is used                                                                       | How your assistant pays                                                      |
| ------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Single-use virtual card  | Ordinary online checkouts that take a Visa or Mastercard                              | Fills the card into the checkout form with its browser, or tokenizes it for a merchant's payment API |
| Shared payment token     | Merchants and APIs that accept agent payments directly (HTTP 402 and the Machine Payments Protocol) | Sends the token with the request. No checkout form is involved. |

Either way the credential is good for one purchase. Card details are written to a file the checkout reads from and are never repeated in the conversation.

## Example prompts

```
"Order two boxes of printer paper from our usual supplier, up to $45"
```

```
"Pay for the report from that API. Real money is fine, cap it at $10"
```

```
"Cancel the spend request you just sent me"
```

```
"Disconnect my Link wallet"
```

Naming a ceiling in the request keeps the approval quick: your assistant will not ask for more than you said, and the Link app shows you exactly what it asked for.

## Troubleshooting

- **The request expired:** You have ten minutes to approve. If it lapses, ask your assistant to send the request again.
- **No payment method:** Link needs at least one saved card or bank account. Add one at [app.link.com/wallet](https://app.link.com/wallet) and retry.
- **The checkout failed after you approved:** The credential is single-use, so your assistant will send a fresh request. Check your Link purchase history before approving again to confirm the first attempt did not go through.
- **The amount is over $500:** That is Link's per-request cap. Split the purchase into smaller requests, or complete that one yourself.
- **Your assistant handed you a checkout link instead of paying:** Link is not connected. Connect it and ask again.
- **Link says the connection needs attention:** Reconnect from Settings or by asking your assistant to reconnect Link. Existing approvals are unaffected.
