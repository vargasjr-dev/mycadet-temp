Cadet is a digital assistant optimized for being hostable anywhere and accessible from anywhere. This page breaks down how it all works from the top down.

## The Cadet Ecosystem

There are three core components in the Cadet Ecosystem:

- Clients & Channels - the avenues by which you can interact with a Cadet
- The Operator - the system that manages multiple Cadets through operations like hatching and retiring. Cadet Cloud is an example of an Operator.
- The Cadet itself - the assistant that can be run anywhere, all the time, serving their guardians.

```mermaid
flowchart LR
  classDef clients fill:#dbeafe,stroke:#60a5fa,color:#1e3a8a
  classDef operator fill:#dcfce7,stroke:#4ade80,color:#14532d
  classDef cadet fill:#fef9c3,stroke:#facc15,color:#713f12

  Clients["Clients"]:::clients
  Channels["Channels"]:::clients
  Operator["Operator"]:::operator
  Cadet1["Cadet 1"]:::cadet
  Cadet2["Cadet 2"]:::cadet
  Cadet3["Cadet 3"]:::cadet

  Clients --> Operator
  Channels --> Operator
  Operator --> Cadet1
  Operator --> Cadet2
  Operator --> Cadet3
```

## How the Cadet Works

The Cadet body is composed of three separate, yet important subsystems:

- Gateway - Manages all incoming requests to the Cadet. It is the boundary that says what can or cannot speak to the Assistant.
- Assistant - The core model loop and workspace. This is where the Assistant spends the majority of its work.
- Credential Vault - Where all the secrets the Cadet needs to authenticate themselves to external systems.

This separation aims to uphold two crucial invariants:

- the Assistant is unable to edit data in the Gateway directly.
- the Assistant is unable to read the secrets stored in the Credential Vault directly.

```mermaid
flowchart LR
  classDef world fill:#f4f4f5,stroke:#a1a1aa,color:#3f3f46
  classDef gateway fill:#dbeafe,stroke:#60a5fa,color:#1e3a8a
  classDef assistant fill:#dcfce7,stroke:#4ade80,color:#14532d
  classDef vault fill:#fef9c3,stroke:#facc15,color:#713f12

  World["Outside world"]:::world
  Gateway["Gateway"]:::gateway
  Assistant["Assistant"]:::assistant
  CES["Credential Vault"]:::vault

  World <--> Gateway
  Gateway <--> Assistant
  Gateway --> CES
  Assistant --> CES
```
