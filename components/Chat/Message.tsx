'use client'

import { useCallback, useState } from 'react'
import { Avatar, Flex, IconButton, Text, Tooltip } from '@radix-ui/themes'
import { FaRegCopy } from 'react-icons/fa'
import { HiUser } from 'react-icons/hi'
import { MdExpandLess, MdExpandMore } from 'react-icons/md'
import { RiRobot2Line } from 'react-icons/ri'
import { Markdown } from '@/components'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { ChatMessage } from './interface'

export interface MessageProps {
  message: ChatMessage
}

const Message = (props: MessageProps) => {
  const { role, content } = props.message
  const isUser = role === 'user'
  const copy = useCopyToClipboard()
  const [tooltipOpen, setTooltipOpen] = useState<boolean>(false)
  const [showThoughtChain, setShowThoughtChain] = useState<boolean>(true)

  const onCopy = useCallback(() => {
    copy(content, (isSuccess) => {
      if (isSuccess) {
        setTooltipOpen(true)
      }
    })
  }, [content, copy])

  // 提取思维链内容和主要内容
  const extractThoughtChain = (content: string) => {
    const thoughts: string[] = []
    let mainContent = ''

    // 提取思维链
    const reasoningRegex = /\[Reasoning\]([\s\S]*?)\[\/Reasoning\]/g
    let match
    while ((match = reasoningRegex.exec(content)) !== null) {
      const thought = match[1]
      if (thought && thought !== 'null') {
        thoughts.push(thought)
      }
    }

    // 提取主要内容
    const contentRegex = /\[Content\]([\s\S]*?)\[\/Content\]/g
    let contentParts: string[] = []
    while ((match = contentRegex.exec(content)) !== null) {
      const contentPart = match[1]
      if (contentPart) {
        contentParts.push(contentPart)
      }
    }

    mainContent = contentParts.length > 0 ? contentParts.join('') : ""

    return {
      thoughts: thoughts.join(''),
      mainContent
    }
  }

  const { thoughts, mainContent } = extractThoughtChain(content)
  const hasThoughts = thoughts.length > 0

  return (
    <Flex gap="4" className="mb-5">
      <Avatar
        fallback={isUser ? <HiUser className="size-4" /> : <RiRobot2Line className="size-4" />}
        color={isUser ? undefined : 'green'}
        size="2"
        radius="full"
      />
      <div className="flex-1 pt-1 break-all">
        {isUser ? (
          <div
            className="userMessage"
            dangerouslySetInnerHTML={{
              __html: content.replace(
                /<(?!\/?(br|img|table|thead|tbody|tr|td|th)\b)[^>]*>/gi,
                ''
              )
            }}
          ></div>
        ) : (
          <Flex direction="column" gap="4">
            {hasThoughts && (
              <Flex direction="column" className="bg-gray-100 dark:bg-gray-800 rounded-lg p-3">
                <Flex align="center" gap="2" className="cursor-pointer" onClick={() => setShowThoughtChain(!showThoughtChain)}>
                  <Text size="2" weight="bold" color="gray">
                    思维链
                  </Text>
                  {showThoughtChain ? <MdExpandLess /> : <MdExpandMore />}
                </Flex>
                {showThoughtChain && (
                  <Flex direction="column" gap="2" className="mt-2">
                    <Text size="2" color="gray" className="pl-4 border-l-2 border-gray-300">
                      {thoughts}
                    </Text>
                  </Flex>
                )}
              </Flex>
            )}
            <Markdown>{mainContent}</Markdown>
            <Flex gap="4" align="center">
              <Tooltip open={tooltipOpen} content="Copied!">
                <IconButton
                  className="cursor-pointer"
                  variant="outline"
                  color="gray"
                  onClick={onCopy}
                  onMouseLeave={() => setTooltipOpen(false)}
                >
                  <FaRegCopy />
                </IconButton>
              </Tooltip>
            </Flex>
          </Flex>
        )}
      </div>
    </Flex>
  )
}

export default Message
