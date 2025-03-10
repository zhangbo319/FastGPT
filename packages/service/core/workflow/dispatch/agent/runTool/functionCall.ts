import { LLMModelItemType } from '@fastgpt/global/core/ai/model.d';
import { getAIApi } from '../../../../ai/config';
import { filterGPTMessageByMaxTokens, loadRequestMessages } from '../../../../chat/utils';
import {
  ChatCompletion,
  StreamChatType,
  ChatCompletionMessageParam,
  ChatCompletionCreateParams,
  ChatCompletionMessageFunctionCall,
  ChatCompletionFunctionMessageParam,
  ChatCompletionAssistantMessageParam
} from '@fastgpt/global/core/ai/type.d';
import { NextApiResponse } from 'next';
import { responseWriteController } from '../../../../../common/response';
import { SseResponseEventEnum } from '@fastgpt/global/core/workflow/runtime/constants';
import { textAdaptGptResponse } from '@fastgpt/global/core/workflow/runtime/utils';
import { ChatCompletionRequestMessageRoleEnum } from '@fastgpt/global/core/ai/constants';
import { dispatchWorkFlow } from '../../index';
import { DispatchToolModuleProps, RunToolResponse, ToolNodeItemType } from './type.d';
import json5 from 'json5';
import { DispatchFlowResponse, WorkflowResponseType } from '../../type';
import { countGptMessagesTokens } from '../../../../../common/string/tiktoken/index';
import { getNanoid, sliceStrStartEnd } from '@fastgpt/global/common/string/tools';
import { AIChatItemType } from '@fastgpt/global/core/chat/type';
import { GPTMessages2Chats } from '@fastgpt/global/core/chat/adapt';
import { updateToolInputValue } from './utils';
import { computedMaxToken, computedTemperature } from '../../../../ai/utils';

type FunctionRunResponseType = {
  toolRunResponse: DispatchFlowResponse;
  functionCallMsg: ChatCompletionFunctionMessageParam;
}[];

export const runToolWithFunctionCall = async (
  props: DispatchToolModuleProps & {
    messages: ChatCompletionMessageParam[];
    toolNodes: ToolNodeItemType[];
    toolModel: LLMModelItemType;
  },
  response?: RunToolResponse
): Promise<RunToolResponse> => {
  const {
    toolModel,
    toolNodes,
    messages,
    res,
    requestOrigin,
    runtimeNodes,
    node,
    stream,
    workflowStreamResponse,
    params: { temperature = 0, maxToken = 4000, aiChatVision }
  } = props;
  const assistantResponses = response?.assistantResponses || [];

  const functions: ChatCompletionCreateParams.Function[] = toolNodes.map((item) => {
    const properties: Record<
      string,
      {
        type: string;
        description: string;
        required?: boolean;
      }
    > = {};
    item.toolParams.forEach((item) => {
      properties[item.key] = {
        type: item.valueType || 'string',
        description: item.toolDescription || ''
      };
    });

    return {
      name: item.nodeId,
      description: item.intro,
      parameters: {
        type: 'object',
        properties,
        required: item.toolParams.filter((item) => item.required).map((item) => item.key)
      }
    };
  });

  const filterMessages = (
    await filterGPTMessageByMaxTokens({
      messages,
      maxTokens: toolModel.maxContext - 300 // filter token. not response maxToken
    })
  ).map((item) => {
    if (item.role === ChatCompletionRequestMessageRoleEnum.Assistant && item.function_call) {
      return {
        ...item,
        function_call: {
          name: item.function_call?.name,
          arguments: item.function_call?.arguments
        },
        content: ''
      };
    }
    return item;
  });
  const [requestMessages, max_tokens] = await Promise.all([
    loadRequestMessages({
      messages: filterMessages,
      useVision: toolModel.vision && aiChatVision,
      origin: requestOrigin
    }),
    computedMaxToken({
      model: toolModel,
      maxToken,
      filterMessages
    })
  ]);
  const requestBody: any = {
    ...toolModel?.defaultConfig,
    model: toolModel.model,
    temperature: computedTemperature({
      model: toolModel,
      temperature
    }),
    max_tokens,
    stream,
    messages: requestMessages,
    functions,
    function_call: 'auto'
  };

  // console.log(JSON.stringify(requestBody, null, 2));
  /* Run llm */
  const ai = getAIApi({
    timeout: 480000
  });
  const aiResponse = await ai.chat.completions.create(requestBody, {
    headers: {
      Accept: 'application/json, text/plain, */*'
    }
  });

  const { answer, functionCalls } = await (async () => {
    if (res && stream) {
      return streamResponse({
        res,
        toolNodes,
        stream: aiResponse,
        workflowStreamResponse
      });
    } else {
      const result = aiResponse as ChatCompletion;
      const function_call = result.choices?.[0]?.message?.function_call;
      const toolNode = toolNodes.find((node) => node.nodeId === function_call?.name);

      const toolCalls = function_call
        ? [
            {
              ...function_call,
              id: getNanoid(),
              toolName: toolNode?.name,
              toolAvatar: toolNode?.avatar
            }
          ]
        : [];

      return {
        answer: result.choices?.[0]?.message?.content || '',
        functionCalls: toolCalls
      };
    }
  })();

  // Run the selected tool.
  const toolsRunResponse = (
    await Promise.all(
      functionCalls.map(async (tool) => {
        if (!tool) return;

        const toolNode = toolNodes.find((node) => node.nodeId === tool.name);

        if (!toolNode) return;

        const startParams = (() => {
          try {
            return json5.parse(tool.arguments);
          } catch (error) {
            return {};
          }
        })();

        const toolRunResponse = await dispatchWorkFlow({
          ...props,
          isToolCall: true,
          runtimeNodes: runtimeNodes.map((item) =>
            item.nodeId === toolNode.nodeId
              ? {
                  ...item,
                  isEntry: true,
                  inputs: updateToolInputValue({ params: startParams, inputs: item.inputs })
                }
              : item
          )
        });

        const stringToolResponse = (() => {
          if (typeof toolRunResponse.toolResponses === 'object') {
            return JSON.stringify(toolRunResponse.toolResponses, null, 2);
          }

          return toolRunResponse.toolResponses ? String(toolRunResponse.toolResponses) : 'none';
        })();

        const functionCallMsg: ChatCompletionFunctionMessageParam = {
          role: ChatCompletionRequestMessageRoleEnum.Function,
          name: tool.name,
          content: stringToolResponse
        };

        workflowStreamResponse?.({
          event: SseResponseEventEnum.toolResponse,
          data: {
            tool: {
              id: tool.id,
              toolName: '',
              toolAvatar: '',
              params: '',
              response: sliceStrStartEnd(stringToolResponse, 500, 500)
            }
          }
        });

        return {
          toolRunResponse,
          functionCallMsg
        };
      })
    )
  ).filter(Boolean) as FunctionRunResponseType;

  const flatToolsResponseData = toolsRunResponse.map((item) => item.toolRunResponse).flat();

  const functionCall = functionCalls[0];
  if (functionCall && !res?.closed) {
    // Run the tool, combine its results, and perform another round of AI calls
    const assistantToolMsgParams: ChatCompletionAssistantMessageParam = {
      role: ChatCompletionRequestMessageRoleEnum.Assistant,
      function_call: functionCall
    };
    const concatToolMessages = [
      ...requestMessages,
      assistantToolMsgParams
    ] as ChatCompletionMessageParam[];
    const tokens = await countGptMessagesTokens(concatToolMessages, undefined, functions);
    const completeMessages = [
      ...concatToolMessages,
      ...toolsRunResponse.map((item) => item?.functionCallMsg)
    ];
    // console.log(tokens, 'tool');

    // Run tool status
    workflowStreamResponse?.({
      event: SseResponseEventEnum.flowNodeStatus,
      data: {
        status: 'running',
        name: node.name
      }
    });

    // tool assistant
    const toolAssistants = toolsRunResponse
      .map((item) => {
        const assistantResponses = item.toolRunResponse.assistantResponses || [];
        return assistantResponses;
      })
      .flat();
    // tool node assistant
    const adaptChatMessages = GPTMessages2Chats(completeMessages);
    const toolNodeAssistant = adaptChatMessages.pop() as AIChatItemType;

    const toolNodeAssistants = [
      ...assistantResponses,
      ...toolAssistants,
      ...toolNodeAssistant.value
    ];

    // concat tool responses
    const dispatchFlowResponse = response
      ? response.dispatchFlowResponse.concat(flatToolsResponseData)
      : flatToolsResponseData;

    /* check stop signal */
    const hasStopSignal = flatToolsResponseData.some(
      (item) => !!item.flowResponses?.find((item) => item.toolStop)
    );
    if (hasStopSignal) {
      return {
        dispatchFlowResponse,
        totalTokens: response?.totalTokens ? response.totalTokens + tokens : tokens,
        completeMessages: filterMessages,
        assistantResponses: toolNodeAssistants
      };
    }

    return runToolWithFunctionCall(
      {
        ...props,
        messages: completeMessages
      },
      {
        dispatchFlowResponse,
        totalTokens: response?.totalTokens ? response.totalTokens + tokens : tokens,
        assistantResponses: toolNodeAssistants
      }
    );
  } else {
    // No tool is invoked, indicating that the process is over
    const gptAssistantResponse: ChatCompletionAssistantMessageParam = {
      role: ChatCompletionRequestMessageRoleEnum.Assistant,
      content: answer
    };
    const completeMessages = filterMessages.concat(gptAssistantResponse);
    const tokens = await countGptMessagesTokens(completeMessages, undefined, functions);
    // console.log(tokens, 'response token');

    // concat tool assistant
    const toolNodeAssistant = GPTMessages2Chats([gptAssistantResponse])[0] as AIChatItemType;

    return {
      dispatchFlowResponse: response?.dispatchFlowResponse || [],
      totalTokens: response?.totalTokens ? response.totalTokens + tokens : tokens,
      completeMessages,
      assistantResponses: [...assistantResponses, ...toolNodeAssistant.value]
    };
  }
};

async function streamResponse({
  res,
  toolNodes,
  stream,
  workflowStreamResponse
}: {
  res: NextApiResponse;
  toolNodes: ToolNodeItemType[];
  stream: StreamChatType;
  workflowStreamResponse?: WorkflowResponseType;
}) {
  const write = responseWriteController({
    res,
    readStream: stream
  });

  let textAnswer = '';
  let functionCalls: ChatCompletionMessageFunctionCall[] = [];
  let functionId = getNanoid();

  for await (const part of stream) {
    if (res.closed) {
      stream.controller?.abort();
      break;
    }

    const responseChoice = part.choices?.[0]?.delta;

    if (responseChoice.content) {
      const content = responseChoice?.content || '';
      textAnswer += content;

      workflowStreamResponse?.({
        write,
        event: SseResponseEventEnum.answer,
        data: textAdaptGptResponse({
          text: content
        })
      });
    } else if (responseChoice.function_call) {
      const functionCall: {
        arguments: string;
        name?: string;
      } = responseChoice.function_call;

      // 流响应中,每次只会返回一个函数，如果带了name，说明触发某个函数
      if (functionCall?.name) {
        functionId = getNanoid();
        const toolNode = toolNodes.find((item) => item.nodeId === functionCall?.name);

        if (toolNode) {
          if (functionCall?.arguments === undefined) {
            functionCall.arguments = '';
          }
          functionCalls.push({
            ...functionCall,
            id: functionId,
            name: functionCall.name,
            toolName: toolNode.name,
            toolAvatar: toolNode.avatar
          });

          workflowStreamResponse?.({
            write,
            event: SseResponseEventEnum.toolCall,
            data: {
              tool: {
                id: functionId,
                toolName: toolNode.name,
                toolAvatar: toolNode.avatar,
                functionName: functionCall.name,
                params: functionCall.arguments,
                response: ''
              }
            }
          });
        }

        continue;
      }

      /* arg 插入最后一个工具的参数里 */
      const arg: string = functionCall?.arguments || '';
      const currentTool = functionCalls[functionCalls.length - 1];
      if (currentTool) {
        currentTool.arguments += arg;

        workflowStreamResponse?.({
          write,
          event: SseResponseEventEnum.toolParams,
          data: {
            tool: {
              id: functionId,
              toolName: '',
              toolAvatar: '',
              params: arg,
              response: ''
            }
          }
        });
      }
    }
  }

  if (!textAnswer && functionCalls.length === 0) {
    return Promise.reject('LLM api response empty');
  }

  return { answer: textAnswer, functionCalls };
}
