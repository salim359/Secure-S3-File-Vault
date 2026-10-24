import json
import urllib.request

import boto3


def send(event, context, status, data, physical_id=None):
    body = json.dumps(
        {
            "Status": status,
            "Reason": f"See CloudWatch log {context.log_stream_name}",
            "PhysicalResourceId": physical_id or event.get("PhysicalResourceId") or context.log_stream_name,
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
            "Data": data,
        }
    ).encode("utf-8")
    request = urllib.request.Request(event["ResponseURL"], data=body, method="PUT")
    request.add_header("content-type", "")
    request.add_header("content-length", str(len(body)))
    with urllib.request.urlopen(request) as response:
        response.read()


def handler(event, context):
    if event["RequestType"] == "Delete":
        send(event, context, "SUCCESS", {})
        return
    try:
        endpoint_id = event["ResourceProperties"]["EndpointId"]
        endpoints = boto3.client("ec2").describe_vpc_endpoints(VpcEndpointIds=[endpoint_id])
        dns_name = endpoints["VpcEndpoints"][0]["DnsEntries"][0]["DnsName"]
        send(event, context, "SUCCESS", {"DnsName": dns_name}, dns_name)
    except Exception as error:
        send(event, context, "FAILED", {"Error": str(error)})
