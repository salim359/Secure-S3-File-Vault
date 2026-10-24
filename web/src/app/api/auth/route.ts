import https from "node:https";
import { Resolver } from "node:dns/promises";
import { NextResponse } from "next/server";

const region = process.env.NEXT_PUBLIC_AWS_REGION || "us-east-1";
const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || "";

function messageFor(type: string, message: string) {
  const name = type.split("#").pop() ?? "";
  if (name === "NotAuthorizedException" || name === "UserNotFoundException") {
    return "Incorrect email or password.";
  }
  if (name === "UserNotConfirmedException") {
    return "Confirm your email before signing in.";
  }
  if (name === "CodeMismatchException") {
    return "That confirmation code is wrong.";
  }
  if (name === "ExpiredCodeException") {
    return "That confirmation code has expired.";
  }
  if (name === "UsernameExistsException") {
    return "An account with this email already exists.";
  }
  if (name === "InvalidPasswordException") {
    return message || "Password must be 12 characters and include upper case, lower case, a number, and a symbol.";
  }
  if (name === "TooManyRequestsException" || name === "LimitExceededException") {
    return "Too many attempts. Wait a moment and try again.";
  }
  return message || "Sign-in failed.";
}

function callCognito(target: string, body: Record<string, unknown>) {
  const payload = JSON.stringify(body);
  const hostname = `cognito-idp.${region}.amazonaws.com`;
  return new Promise<{ status: number; body: { __type?: string; message?: string } }>(async (resolve, reject) => {
    let addresses: string[];
    try {
      addresses = await new Resolver().resolve4(hostname);
    } catch (error) {
      reject(error);
      return;
    }
    const attempt = (index: number) => {
      const req = https.request(
        {
          host: addresses[index],
          servername: hostname,
          path: "/",
          method: "POST",
          headers: {
            host: hostname,
            "content-type": "application/x-amz-json-1.1",
            "x-amz-target": target,
            "content-length": Buffer.byteLength(payload),
          },
          timeout: 8000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 500,
              body: text ? (JSON.parse(text) as { __type?: string; message?: string }) : {},
            });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => {
        if (index + 1 < addresses.length) attempt(index + 1);
        else reject(new Error("Could not reach Cognito."));
      });
      req.end(payload);
    };
    if (addresses.length === 0) reject(new Error("Could not reach Cognito."));
    else attempt(0);
  });
}

export async function POST(request: Request) {
  if (!clientId) {
    return NextResponse.json(
      { message: "Set NEXT_PUBLIC_COGNITO_CLIENT_ID, then restart the app." },
      { status: 500 },
    );
  }
  const body = (await request.json().catch(() => null)) as {
    action?: string;
    email?: string;
    password?: string;
    confirmationCode?: string;
  } | null;
  const email = body?.email?.trim() ?? "";
  const password = body?.password ?? "";
  let cognitoBody: Record<string, unknown>;
  if (body?.action === "InitiateAuth") {
    cognitoBody = {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    };
  } else if (body?.action === "SignUp") {
    cognitoBody = {
      ClientId: clientId,
      Username: email,
      Password: password,
      UserAttributes: [{ Name: "email", Value: email }],
    };
  } else if (body?.action === "ConfirmSignUp") {
    cognitoBody = {
      ClientId: clientId,
      Username: email,
      ConfirmationCode: body.confirmationCode?.trim() ?? "",
    };
  } else if (body?.action === "ForgotPassword") {
    cognitoBody = {
      ClientId: clientId,
      Username: email,
    };
  } else if (body?.action === "ConfirmForgotPassword") {
    cognitoBody = {
      ClientId: clientId,
      Username: email,
      ConfirmationCode: body.confirmationCode?.trim() ?? "",
      Password: password,
    };
  } else {
    return NextResponse.json({ message: "Unknown sign-in action." }, { status: 400 });
  }

  let result: { __type?: string; message?: string };
  let status: number;
  try {
    const called = await callCognito(`AWSCognitoIdentityProviderService.${body?.action}`, cognitoBody);
    result = called.body;
    status = called.status;
  } catch {
    return NextResponse.json({ message: "Could not reach Cognito." }, { status: 502 });
  }
  if (status < 200 || status >= 300) {
    return NextResponse.json(
      { message: messageFor(String(result.__type ?? ""), String(result.message ?? "")) },
      { status: 400 },
    );
  }
  return NextResponse.json(result);
}
