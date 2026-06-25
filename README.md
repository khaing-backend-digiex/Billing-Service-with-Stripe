# NestJS Stripe Boilerplate

A production-ready **NestJS** starter project with **Stripe** integration, **JWT authentication**, and **role-based access control (RBAC)**.

## 🚀 Features

- **NestJS 11** — Modern, modular Node.js framework
- **Stripe Integration** — Checkout Sessions, Payment Intents, Billing Portal, Webhooks
- **JWT Authentication** — Passport-based with `@nestjs/passport`
- **Role-Based Access Control** — Admin / Manager / User roles with custom guards
- **PostgreSQL + TypeORM** — Type-safe database access with entities and repositories
- **Swagger/OpenAPI** — Auto-generated API documentation at `/api/docs`
- **Class Validation** — Request DTOs validated with `class-validator`
- **Global Error Handling** — Consistent error response format
- **Health Check** — Built-in health endpoint

## 📋 Tech Stack

| Technology | Purpose |
|---|---|
| NestJS | Application framework |
| TypeORM | ORM / Database |
| PostgreSQL | Database |
| Passport + JWT | Authentication |
| Stripe SDK | Payments |
| Swagger | API Documentation |
| class-validator | DTO Validation |
| bcrypt | Password Hashing |

## 🛠 Getting Started

### Prerequisites

- **Node.js** 18+
- **PostgreSQL** running locally or remotely
- **Stripe Account** — [Get API keys](https://dashboard.stripe.com/apikeys)

### Installation

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

### Configuration

Edit the `.env` file with your values:

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_database
DB_USER=your_user
DB_PASSWORD=your_password
DB_SYNCHRONIZE=true

# JWT
JWT_SECRET=your_secret_key
JWT_EXPIRES_IN=1h

# Stripe (from https://dashboard.stripe.com/apikeys)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SUCCESS_URL=http://localhost:3000/success
STRIPE_CANCEL_URL=http://localhost:3000/cancel
```

### Running the App

```bash
# Development (with hot-reload)
npm run start:dev

# Production build
npm run build
npm run start:prod
```

### Stripe Webhook (Local Development)

To test webhooks locally, use the [Stripe CLI](https://stripe.com/docs/stripe-cli):

```bash
# Install Stripe CLI, then:
stripe listen --forward-to localhost:3000/stripe/webhook

# Copy the webhook signing secret (whsec_...) to your .env file
```

## 📚 API Endpoints

### Public Endpoints (No Auth Required)

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/auth/register` | Register new user |
| `POST` | `/auth/login` | Login & get JWT token |
| `POST` | `/stripe/webhook` | Stripe webhook handler |

### Protected Endpoints (JWT Required)

| Method | Path | Roles | Description |
|---|---|---|---|
| `GET` | `/users` | Admin, Manager | List all users |
| `GET` | `/users/:id` | Authenticated | Get user by ID |
| `POST` | `/users` | Admin, Manager | Create user |
| `PUT` | `/users/:id` | Admin, Manager | Update user |
| `DELETE` | `/users/:id` | Admin | Delete user |
| `POST` | `/stripe/customers` | Authenticated | Create Stripe customer |
| `POST` | `/stripe/checkout` | Authenticated | Create checkout session |
| `POST` | `/stripe/payment-intent` | Authenticated | Create payment intent |
| `POST` | `/stripe/billing-portal` | Authenticated | Open billing portal |
| `GET` | `/stripe/payments` | Authenticated | Get payment history |

### Swagger Documentation

Once the app is running, visit: **http://localhost:3000/api/docs**

## 📁 Project Structure

```
src/
├── main.ts                              # App bootstrap (raw body, Swagger, CORS)
├── app.module.ts                        # Root module
├── config/
│   └── config.module.ts                 # Environment configuration
├── database/
│   ├── database.module.ts               # TypeORM PostgreSQL setup
│   └── entities/
│       ├── user.entity.ts               # User entity (+ stripeCustomerId)
│       └── payment.entity.ts            # Payment history entity
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts               # Login / Register
│   ├── auth.service.ts                  # JWT signing, bcrypt validation
│   ├── strategies/
│   │   └── jwt.strategy.ts              # Passport JWT strategy
│   └── dto/
│       ├── login.dto.ts
│       └── register.dto.ts
├── users/
│   ├── users.module.ts
│   ├── users.controller.ts              # User CRUD
│   ├── users.service.ts
│   └── dto/
│       ├── create-user.dto.ts
│       └── update-user.dto.ts
├── stripe/
│   ├── stripe.module.ts
│   ├── stripe.service.ts               # Core Stripe SDK wrapper
│   ├── stripe.controller.ts            # Checkout, PaymentIntent, Portal
│   ├── webhook/
│   │   ├── stripe-webhook.controller.ts # Webhook endpoint
│   │   └── stripe-webhook.service.ts    # Event handling
│   └── dto/
│       ├── create-checkout.dto.ts
│       ├── create-customer.dto.ts
│       └── create-payment-intent.dto.ts
├── health/
│   └── health.controller.ts             # Health check
└── common/
    ├── constants/
    │   └── roles.enum.ts                # Role definitions
    ├── decorators/
    │   ├── public.decorator.ts          # @Public() bypass JWT
    │   ├── roles.decorator.ts           # @Roles() for RBAC
    │   └── get-user.decorator.ts        # @GetUser() param decorator
    ├── guards/
    │   ├── jwt-auth.guard.ts            # Global JWT guard
    │   └── roles.guard.ts              # Role-based guard
    ├── dto/
    │   └── api-response.dto.ts          # Standard response wrapper
    └── exceptions/
        └── http-exception.filter.ts     # Global exception filter
```

## 🔐 Authentication Flow

1. **Register** → `POST /auth/register` (creates user with default `user` role)
2. **Login** → `POST /auth/login` (returns JWT access token)
3. **Use Token** → Add `Authorization: Bearer <token>` header to requests
4. **Role Check** → Endpoints decorated with `@Roles()` check user roles

## 💳 Stripe Integration Flow

1. **Create Customer** → `POST /stripe/customers` (links Stripe customer to user)
2. **Create Checkout** → `POST /stripe/checkout` (returns Stripe Checkout URL)
3. **Payment Intent** → `POST /stripe/payment-intent` (returns client secret)
4. **Billing Portal** → `POST /stripe/billing-portal` (returns portal URL)
5. **Webhooks** → `POST /stripe/webhook` (handles Stripe events automatically)

## 📄 License

MIT
