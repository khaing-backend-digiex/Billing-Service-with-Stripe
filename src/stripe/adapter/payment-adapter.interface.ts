import Stripe from "stripe";

export type StripeSubscription = Stripe.Subscription;
export type StripePaymentMethod = Stripe.PaymentMethod;
export type StripeInvoice = Stripe.Invoice;
export type StripeCheckoutSession = Stripe.Checkout.Session;
export type StripeCustomer = Stripe.Customer;
export type StripeDeletedCustomer = Stripe.DeletedCustomer;

export type StripePaymentIntent = Stripe.PaymentIntent;
export type StripeBillingPortalSession = Stripe.BillingPortal.Session;
export type StripeEvent = Stripe.Event;

export interface IPaymentAdapter {
    createCustomer(userId: number, email: string, name?: string): Promise<StripeCustomer>;
    deleteCustomer(customerId: string): Promise<void>;
    getCustomer(customerId: string): Promise<StripeCustomer | StripeDeletedCustomer>;
    customerExists(customerId: string): Promise<boolean>;
    getFreePriceId(): Promise<string | null>;
    ensureFreeSubscription(customerId: string): Promise<StripeSubscription | null>;
    findActiveSubscription(customerId: string): Promise<StripeSubscription | null>;
    getLatestPaidInvoice(subscriptionId: string): Promise<StripeInvoice | null>;
    subscribeToFreePlan(customerId: string): Promise<StripeSubscription | null>;
    hasDefaultPaymentMethod(customerId: string): Promise<boolean>;
    createCheckoutSession(
        userId: number,
        priceId: string,
        mode?: "payment" | "subscription",
        customerId?: string,
        extraMetadata?: Record<string, string>,
        successUrl?: string,
        cancelUrl?: string,
    ): Promise<StripeCheckoutSession>;
    createPaymentIntent(
        userId: number,
        amount: number,
        currency?: string,
        description?: string,
        customerId?: string,
    ): Promise<StripePaymentIntent>;
    createBillingPortalSession(
        customerId: string,
        returnUrl?: string,
    ): Promise<StripeBillingPortalSession>;
    constructWebhookEvent(
        rawBody: Buffer,
        signature: string,
    ): StripeEvent;
    cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void>;
    cancelSubscriptionNow(subscriptionId: string): Promise<void>;
}