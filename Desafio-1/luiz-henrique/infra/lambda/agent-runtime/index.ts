import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  UpdateAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
  GetAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { randomUUID } from 'crypto';

const client = new BedrockAgentCoreControlClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
});

interface ProviderEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: {
    AgentRuntimeName: string;
    ContainerUri: string;
    RoleArn: string;
    EnvironmentVariables: Record<string, string>;
  };
}

export async function onEvent(event: ProviderEvent) {
  const props = event.ResourceProperties;

  if (event.RequestType === 'Create') {
    const result = await client.send(
      new CreateAgentRuntimeCommand({
        agentRuntimeName: props.AgentRuntimeName,
        agentRuntimeArtifact: {
          containerConfiguration: { containerUri: props.ContainerUri },
        },
        roleArn: props.RoleArn,
        networkConfiguration: { networkMode: 'PUBLIC' },
        environmentVariables: props.EnvironmentVariables,
        clientToken: randomUUID(),
      })
    );

    return {
      PhysicalResourceId: result.agentRuntimeId || result.agentRuntimeArn,
      Data: {
        AgentRuntimeArn: result.agentRuntimeArn,
        AgentRuntimeId: result.agentRuntimeId,
        AgentRuntimeVersion: result.agentRuntimeVersion,
      },
    };
  }

  if (event.RequestType === 'Update') {
    const result = await client.send(
      new UpdateAgentRuntimeCommand({
        agentRuntimeId: event.PhysicalResourceId!,
        agentRuntimeArtifact: {
          containerConfiguration: { containerUri: props.ContainerUri },
        },
        roleArn: props.RoleArn,
        networkConfiguration: { networkMode: 'PUBLIC' },
        environmentVariables: props.EnvironmentVariables,
        clientToken: randomUUID(),
      })
    );

    return {
      PhysicalResourceId: event.PhysicalResourceId,
      Data: {
        AgentRuntimeArn: result.agentRuntimeArn,
        AgentRuntimeId: event.PhysicalResourceId,
        AgentRuntimeVersion: result.agentRuntimeVersion,
      },
    };
  }

  await client.send(
    new DeleteAgentRuntimeCommand({
      agentRuntimeId: event.PhysicalResourceId!,
    })
  );

  return { PhysicalResourceId: event.PhysicalResourceId };
}

export async function isComplete(event: ProviderEvent) {
  const agentRuntimeId = event.PhysicalResourceId;
  if (!agentRuntimeId) {
    return { IsComplete: true };
  }

  if (event.RequestType === 'Delete') {
    try {
      await client.send(new GetAgentRuntimeCommand({ agentRuntimeId }));
      return { IsComplete: false };
    } catch (_) {
      return { IsComplete: true };
    }
  }

  try {
    const result = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId }));
    const status = result.status;
    return {
      IsComplete: status === 'READY' || status === 'CREATE_FAILED' || status === 'UPDATE_FAILED',
      Data: {
        AgentRuntimeArn: result.agentRuntimeArn,
        AgentRuntimeId: result.agentRuntimeId,
        AgentRuntimeVersion: result.agentRuntimeVersion,
      },
    };
  } catch (_) {
    return { IsComplete: false };
  }
}
