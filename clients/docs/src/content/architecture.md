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

  Clients -.-> Operator
  Channels -.-> Operator
  Operator -.-> Cadet1
  Operator -.-> Cadet2
  Operator -.-> Cadet3
```

## How the Cadet Works

The Cadet body is composed of three separate, yet important subsystems:

- Gateway - Manages all incoming requests to the Cadet. It is the boundary that says what can or cannot speak to the Assistant.
- Assistant - The core model loop and workspace. This is where the Assistant spends the majority of its work.
- Credential Vault - Where all the secrets the Cadet needs to authenticate themselves to external systems.

This separation aims to uphold two crucial invariants:

- the Assistant is unable to edit data in the Gateway directly.
- the Assistant is unable to read the secrets stored in the Credential Vault directly.

Colors on the arrows carry the access meaning:

- red is read/write — the dangerous direction, worth seeing coming
- blue read-only
- violet read-metadata-only
- orange is just traffic movement: packets flowing, no access either way

```mermaid
flowchart LR
  classDef world fill:#f4f4f5,stroke:#a1a1aa,color:#3f3f46
  classDef gateway fill:#dbeafe,stroke:#60a5fa,color:#1e3a8a
  classDef assistant fill:#dcfce7,stroke:#4ade80,color:#14532d
  classDef vault fill:#fef9c3,stroke:#facc15,color:#713f12

  World["Outside world"]:::world
  Gateway["Gateway"]:::gateway
  Assistant["Assistant"]:::assistant
  CES["Credential Vault&nbsp;"]:::vault

  World <-.-> Gateway
  Gateway -.-> Assistant
  Assistant -.-> Gateway
  Gateway -.-> CES
  Assistant -.-> CES
  linkStyle 1 stroke:#ef4444
  linkStyle 2 stroke:#3b82f6
  linkStyle 3 stroke:#ef4444
  linkStyle 4 stroke:#a855f7
```

## How the Gateway Works

The Gateway is the front door controlling all of the data that comes from the outside world into the Assistant. It is made up of the following components:

- Web Server - The main listener routing both HTTP and WebSocket connections from the outside world
- IPC Server - The main entrypoint where the Assistant can read data from the Gateway.
- File System - The location where the gateway manages all of its data, including logs and its own SQlite database. A default value of `/gateway-security` that can be overridden with `$GATEWAY_SECURITY_DIR`.
- IPC Clients - How it communicates to the Assistant and the Credential Vault
- Tunnel Client - How it connects directly to the outside world, when not receiving its requests from the Operator.
- Scheduler - A process running routine work that keeps the Gateway healthy.

The arrows keep the access convention from the data-plane diagram above:
red edges write (the Gateway reaching the Assistant, the Credential Vault,
and its own file system), blue edges are the Assistant reading back, and
orange edges are just traffic moving through — the world reaching the Web
Server, the Tunnel Client shuttling both ways.

```mermaid
flowchart LR
  classDef world fill:#f4f4f5,stroke:#a1a1aa,color:#3f3f46
  classDef assistant fill:#dcfce7,stroke:#4ade80,color:#14532d
  classDef vault fill:#fef9c3,stroke:#facc15,color:#713f12
  classDef store fill:#f5f5f4,stroke:#a8a29e,color:#44403c

  subgraph gatewayBox["Gateway"]
    style gatewayBox fill:#dbeafe,stroke:#60a5fa,color:#1e3a8a
    WebServer["Web Server"]
    IpcServer["IPC Server"]
    IpcClients["IPC Clients"]
    TunnelClient["Tunnel Client"]
    SecurityDir[("File System")]
    Scheduler["Scheduler"]
  end

  World["Outside world"]:::world
  Assistant["Assistant"]:::assistant
  CES["Credential Vault&nbsp;"]:::vault

  World -.-> WebServer
  WebServer -.-> IpcClients
  Assistant -.-> IpcServer
  IpcClients -.-> Assistant
  IpcClients -.-> CES
  TunnelClient -.-> World
  TunnelClient -.-> WebServer
  WebServer -.-> SecurityDir
  IpcServer -.-> SecurityDir
  Scheduler -.-> SecurityDir
  linkStyle 0,5,6 stroke:#f97316
  linkStyle 1,3,4,7,9 stroke:#ef4444
  linkStyle 2,8 stroke:#3b82f6
```
